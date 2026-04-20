// Copyright 2026 Nikolay Samokhvalov.

// Work-call tests for the Claude adapter. Uses a spawn-spy that
// optionally delegates to the fake-CLI harness for end-to-end
// stdout-through-pre-parser behavior.
//
// Covers (SPEC §7, §11, §13 test 4):
// - auth_status: subscription_auth detection (both branches)
// - spawn-spy: non-interactive flags (--print --dangerously-skip-permissions)
// - spawn-spy: minimal env forwarded
// - spawn-spy: --model pin
// - schema-violation repair: one retry, then terminal
// - `usage: null` path
// - revise() emits JSON-backed `ready` + `rationale`
// - capped timeout retry (base → +50% → base → terminal)
// - Markdown-code-fence stripping end-to-end
//
// Fixtures live under tests/fixtures/claude-fixtures/.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dirname } from "node:path";

import { ClaudeAdapter, ClaudeAdapterError } from "../../src/adapter/claude.ts";
import {
  type AskInput,
  type CritiqueInput,
  type EffortLevel,
  type ReviseInput,
} from "../../src/adapter/types.ts";
import {
  type SpawnCliInput,
  type SpawnCliResult,
} from "../../src/adapter/spawn.ts";
import { spawnCli } from "../../src/adapter/spawn.ts";

// Tests that spawn the fake-cli need `bun` reachable via PATH.
const BUN_DIR = dirname(process.execPath);

const FAKE_CLI = new URL("../fixtures/fake-cli.ts", import.meta.url).pathname;

function claudeFixture(name: string): string {
  return new URL(`../fixtures/claude-fixtures/${name}`, import.meta.url)
    .pathname;
}

const TMP: string[] = [];

function makeFakeBinaryDir(
  name: string,
  script: string,
): { dir: string; binary: string } {
  const dir = mkdtempSync(join(tmpdir(), "samospec-claude-bin-"));
  TMP.push(dir);
  const binary = join(dir, name);
  writeFileSync(binary, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(binary, 0o755);
  return { dir, binary };
}

afterAll(() => {
  for (const d of TMP) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ---------- spawn-spy ----------

interface SpawnSpyCall {
  readonly cmd: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly timeoutMs: number;
  readonly stdinLen: number;
  readonly extraAllowedEnvKeys: readonly string[];
}

interface SpawnSpy {
  readonly spawn: (input: SpawnCliInput) => Promise<SpawnCliResult>;
  readonly calls: SpawnSpyCall[];
}

/**
 * Spy-only: records every call and returns a canned scripted result.
 * `scripted` may be a single response or an array indexed by call #.
 */
function makeSpy(
  scripted: SpawnCliResult | readonly SpawnCliResult[],
): SpawnSpy {
  const calls: SpawnSpyCall[] = [];
  const spawn = (input: SpawnCliInput): Promise<SpawnCliResult> => {
    calls.push({
      cmd: [...input.cmd],
      env: { ...input.env },
      timeoutMs: input.timeoutMs,
      stdinLen: input.stdin.length,
      extraAllowedEnvKeys: [...(input.extraAllowedEnvKeys ?? [])],
    });
    const result = Array.isArray(scripted)
      ? (scripted[calls.length - 1] ?? scripted[scripted.length - 1]!)
      : (scripted as SpawnCliResult);
    return Promise.resolve(result);
  };
  return { spawn, calls };
}

/**
 * Hybrid spy: records every call, then delegates to the fake-CLI
 * harness by rewriting the cmd to `bun run FAKE_CLI`. Forwards the
 * fixture path + state file via env. Injects bun's dir into PATH so
 * the subprocess can locate the bun runtime under minimal-env.
 */
function makeFakeCliSpy(opts: {
  fixture: string;
  stateFile?: string;
}): SpawnSpy {
  const calls: SpawnSpyCall[] = [];
  const spawn = async (input: SpawnCliInput): Promise<SpawnCliResult> => {
    calls.push({
      cmd: [...input.cmd],
      env: { ...input.env },
      timeoutMs: input.timeoutMs,
      stdinLen: input.stdin.length,
      extraAllowedEnvKeys: [...(input.extraAllowedEnvKeys ?? [])],
    });
    const env: Record<string, string | undefined> = {
      ...input.env,
      FAKE_CLI_FIXTURE: opts.fixture,
    };
    if (opts.stateFile !== undefined) {
      env["FAKE_CLI_STATE_FILE"] = opts.stateFile;
    }
    // Merge host PATH (for the fake-bin) with BUN_DIR (for the bun
    // interpreter) so `bun run FAKE_CLI` resolves under minimal-env.
    const hostSnapshot: Record<string, string | undefined> = {
      ...(input.host ?? {}),
    };
    const hostPath = hostSnapshot["PATH"] ?? "";
    const mergedPath = hostPath === "" ? BUN_DIR : `${BUN_DIR}:${hostPath}`;
    hostSnapshot["PATH"] = mergedPath;

    const rewritten: SpawnCliInput = {
      cmd: ["bun", "run", FAKE_CLI],
      stdin: input.stdin,
      env,
      timeoutMs: input.timeoutMs,
      extraAllowedEnvKeys: [
        ...(input.extraAllowedEnvKeys ?? []),
        "FAKE_CLI_FIXTURE",
        "FAKE_CLI_STATE_FILE",
      ],
      host: hostSnapshot,
    };
    return await spawnCli(rewritten);
  };
  return { spawn, calls };
}

// ---------- helpers ----------

const OPTS_MAX_120: { effort: EffortLevel; timeout: number } = {
  effort: "max",
  timeout: 120_000,
};

function makeInstalledHost(): {
  host: Record<string, string | undefined>;
  binaryPath: string;
} {
  const { dir, binary } = makeFakeBinaryDir("claude", 'echo "2.1.114"');
  return {
    // Include a fake API key so auth_status() returns
    // usable_for_noninteractive:true. Work-call tests exercise spawn
    // behavior, not subscription-auth gating; the key is never used
    // for a real API call (no real claude binary is invoked).
    host: {
      PATH: dir,
      HOME: "/tmp",
      ANTHROPIC_API_KEY: "sk-ant-test-fake-key",
    },
    binaryPath: binary,
  };
}

function sampleAsk(): AskInput {
  return { prompt: "ping", context: "", opts: OPTS_MAX_120 };
}
function sampleCritique(): CritiqueInput {
  return {
    spec: "# SPEC\n\nplaceholder",
    guidelines: "be paranoid",
    opts: OPTS_MAX_120,
  };
}
function sampleRevise(): ReviseInput {
  return {
    spec: "# SPEC\n\nplaceholder",
    reviews: [],
    decisions_history: [],
    opts: OPTS_MAX_120,
  };
}

// ---------- auth_status ----------

describe("ClaudeAdapter.auth_status (SPEC §11 subscription-auth)", () => {
  test("no binary on PATH -> { authenticated: false }", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "samospec-empty-"));
    TMP.push(emptyDir);
    const adapter = new ClaudeAdapter({
      host: { PATH: emptyDir, HOME: "/tmp" },
    });
    const result = await adapter.auth_status();
    expect(result.authenticated).toBe(false);
  });

  test("binary present + ANTHROPIC_API_KEY set -> subscription_auth=false", async () => {
    const { host } = makeInstalledHost();
    const adapter = new ClaudeAdapter({
      host: { ...host, ANTHROPIC_API_KEY: "sk-test-not-a-real-key" },
    });
    const result = await adapter.auth_status();
    expect(result.authenticated).toBe(true);
    expect(result.subscription_auth).toBe(false);
  });

  test("binary present + no API key -> subscription_auth=true (keychain assumed)", async () => {
    const { host } = makeInstalledHost();
    // Strip the API key that makeInstalledHost() now includes so we can
    // test the subscription-auth heuristic in isolation.
    const noKeyHost = { ...host, ANTHROPIC_API_KEY: undefined };
    const adapter = new ClaudeAdapter({ host: noKeyHost });
    const result = await adapter.auth_status();
    expect(result.authenticated).toBe(true);
    expect(result.subscription_auth).toBe(true);
    expect(result.usable_for_noninteractive).toBe(false);
  });
});

// ---------- spawn-spy: flags + env + model ----------

describe("ClaudeAdapter spawn flags + minimal env (SPEC §7)", () => {
  test("ask() passes --print --dangerously-skip-permissions and --model pin", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout: '{"answer":"ok","usage":null,"effort_used":"max"}',
      stderr: "",
    });
    const { host } = makeInstalledHost();
    const adapter = new ClaudeAdapter({ host, spawn: spy.spawn });

    await adapter.ask(sampleAsk());

    // First spawn-spy call may be a version probe (detect-style).
    // Look at the call that carried the prompt on stdin.
    const workCall = spy.calls.find((c) => c.stdinLen > 0);
    expect(workCall).toBeDefined();
    if (workCall === undefined) return;
    expect(workCall.cmd).toContain("--print");
    expect(workCall.cmd).toContain("--dangerously-skip-permissions");
    expect(workCall.cmd).toContain("--model");
    expect(workCall.cmd).toContain("claude-opus-4-7");
  });

  test("work-call spawn forwards only HOME, PATH, TMPDIR, Claude auth vars", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout: '{"answer":"ok","usage":null,"effort_used":"max"}',
      stderr: "",
    });
    const { host } = makeInstalledHost();
    const adapter = new ClaudeAdapter({
      host: { ...host, TMPDIR: "/tmp", ANTHROPIC_API_KEY: "sk-test" },
      spawn: spy.spawn,
    });
    await adapter.ask(sampleAsk());

    const workCall = spy.calls.find((c) => c.stdinLen > 0);
    expect(workCall).toBeDefined();
    if (workCall === undefined) return;
    // extraAllowedEnvKeys must include the Claude auth key so spawnCli
    // forwards it from host into child env.
    expect(workCall.extraAllowedEnvKeys).toContain("ANTHROPIC_API_KEY");
  });

  test("end-to-end minimal-env: fake-CLI child sees only allowlist keys (no host secrets leak)", async () => {
    // Captures the child's env dump by wrapping the adapter's spawn
    // with a "peek" layer: the wrapper records the child's stdout
    // (the raw env_keys JSON) and then returns a canned schema-valid
    // JSON to keep ask() happy.
    const echoEnv = new URL(
      "../fixtures/fake-cli-fixtures/echo-env.json",
      import.meta.url,
    ).pathname;
    let capturedKeys: readonly string[] = [];

    const peekSpawn = async (input: SpawnCliInput): Promise<SpawnCliResult> => {
      // First, run the fake-cli for real to capture the env dump.
      const env: Record<string, string | undefined> = {
        ...input.env,
        FAKE_CLI_FIXTURE: echoEnv,
      };
      const hostSnapshot: Record<string, string | undefined> = {
        ...(input.host ?? {}),
      };
      const hostPath = hostSnapshot["PATH"] ?? "";
      hostSnapshot["PATH"] =
        hostPath === "" ? BUN_DIR : `${BUN_DIR}:${hostPath}`;

      const raw = await spawnCli({
        cmd: ["bun", "run", FAKE_CLI],
        stdin: input.stdin,
        env,
        timeoutMs: input.timeoutMs,
        extraAllowedEnvKeys: [
          ...(input.extraAllowedEnvKeys ?? []),
          "FAKE_CLI_FIXTURE",
        ],
        host: hostSnapshot,
      });
      if (raw.ok) {
        const parsed = JSON.parse(raw.stdout) as { keys?: string[] };
        capturedKeys = parsed.keys ?? [];
      }
      // Return canned JSON for ask() to validate cleanly.
      return {
        ok: true,
        exitCode: 0,
        stdout: '{"answer":"ok","usage":null,"effort_used":"max"}',
        stderr: "",
      };
    };

    const { host } = makeInstalledHost();
    const adapter = new ClaudeAdapter({
      host: {
        ...host,
        TMPDIR: "/tmp",
        ANTHROPIC_API_KEY: "sk-forwarded-value",
        LEAKY_HOST_SECRET: "nope",
      },
      spawn: peekSpawn,
    });

    await adapter.ask(sampleAsk());

    // Allowlist: HOME, PATH, TMPDIR, ANTHROPIC_API_KEY (+ harness
    // FAKE_CLI_FIXTURE for the peek wrapper). Nothing else host-side.
    expect(capturedKeys).toContain("ANTHROPIC_API_KEY");
    expect(capturedKeys).not.toContain("LEAKY_HOST_SECRET");
  });

  test("revise() returns ready + rationale from JSON body, not parsed from Markdown prose", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout:
        '{"spec":"# SPEC\\n\\nrevised.","ready":true,' +
        '"rationale":"looks good","usage":null,"effort_used":"max"}',
      stderr: "",
    });
    const { host } = makeInstalledHost();
    const adapter = new ClaudeAdapter({ host, spawn: spy.spawn });

    const out = await adapter.revise(sampleRevise());
    expect(out.ready).toBe(true);
    expect(out.rationale).toBe("looks good");
    expect(out.spec).toContain("# SPEC");
    expect(out.usage).toBeNull();
  });

  test("revise() returns ready=false when model signals not ready", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout:
        '{"spec":"# SPEC\\n\\n.","ready":false,' +
        '"rationale":"more rounds","usage":null,"effort_used":"max"}',
      stderr: "",
    });
    const { host } = makeInstalledHost();
    const adapter = new ClaudeAdapter({ host, spawn: spy.spawn });
    const out = await adapter.revise(sampleRevise());
    expect(out.ready).toBe(false);
  });

  test("usage defaults to null when CLI omits it", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      // No "usage" field in the response body at all.
      stdout: '{"answer":"no usage info"}',
      stderr: "",
    });
    const { host } = makeInstalledHost();
    const adapter = new ClaudeAdapter({ host, spawn: spy.spawn });
    const out = await adapter.ask(sampleAsk());
    expect(out.usage).toBeNull();
    // effort_used defaults to requested when CLI omits it.
    expect(out.effort_used).toBe("max");
  });
});

// ---------- schema-violation repair (end-to-end via fake-CLI) ----------

describe("ClaudeAdapter schema-violation repair (SPEC §7)", () => {
  test("happy ask(): fake-CLI emits valid JSON once", async () => {
    const spy = makeFakeCliSpy({
      fixture: claudeFixture("ask-happy.json"),
    });
    const { host } = makeInstalledHost();
    const adapter = new ClaudeAdapter({ host, spawn: spy.spawn });
    const out = await adapter.ask(sampleAsk());
    expect(out.answer).toBe("hello from claude");
    expect(out.usage).toBeNull();
  });

  test("schema-violation then repair: first call garbage, second valid", async () => {
    const stateFile = mkdtempSync(join(tmpdir(), "samospec-claude-state-"));
    TMP.push(stateFile);
    const stateJson = join(stateFile, "call-state.json");
    writeFileSync(stateJson, JSON.stringify({ call: 0 }));

    const spy = makeFakeCliSpy({
      fixture: claudeFixture("ask-schema-repair.json"),
      stateFile: stateJson,
    });
    const { host } = makeInstalledHost();
    const adapter = new ClaudeAdapter({ host, spawn: spy.spawn });

    const out = await adapter.ask(sampleAsk());
    expect(out.answer).toBe("repaired");
    // Exactly two spawns: one bad, one repair.
    expect(spy.calls.length).toBe(2);
  });

  test("schema-violation twice: terminal after ONE repair retry", async () => {
    const spy = makeFakeCliSpy({
      fixture: claudeFixture("ask-schema-fatal.json"),
    });
    const { host } = makeInstalledHost();
    const adapter = new ClaudeAdapter({ host, spawn: spy.spawn });

    let err: unknown;
    try {
      await adapter.ask(sampleAsk());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ClaudeAdapterError);
    if (err instanceof ClaudeAdapterError) {
      expect(err.payload.reason).toBe("schema_violation");
      expect(err.payload.kind).toBe("terminal");
    }
    // Two spawns per timeout-attempt (original + repair). Since the
    // repair fails, this is classified schema_violation and the
    // capped-retry helper does NOT retry schema violations — so
    // exactly 2 spawns total.
    expect(spy.calls.length).toBe(2);
  });

  test("Markdown-fenced JSON is stripped and validated end-to-end", async () => {
    const spy = makeFakeCliSpy({
      fixture: claudeFixture("ask-fenced.json"),
    });
    const { host } = makeInstalledHost();
    const adapter = new ClaudeAdapter({ host, spawn: spy.spawn });

    const out = await adapter.ask(sampleAsk());
    expect(out.answer).toBe("fenced-ok");
    expect(out.usage).toBeNull();
  });
});

// ---------- exit-code classification ----------

describe("ClaudeAdapter exit-code classification (SPEC §7)", () => {
  test("non-zero exit with terminal stderr -> terminal error, no retry", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 2,
      stdout: "",
      stderr: "unauthorized: no token",
    });
    const { host } = makeInstalledHost();
    const adapter = new ClaudeAdapter({ host, spawn: spy.spawn });

    let err: unknown;
    try {
      await adapter.ask(sampleAsk());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ClaudeAdapterError);
    if (err instanceof ClaudeAdapterError) {
      expect(err.payload.kind).toBe("terminal");
      expect(err.payload.reason).toBe("other");
    }
    // No retry: runWithCappedRetry bails on non-timeout failure.
    expect(spy.calls.length).toBe(1);
  });

  test("non-zero exit with rate-limit stderr -> retried as timeout class", async () => {
    // Every attempt returns the same rate-limit error; runWithCappedRetry
    // retries 3 times before giving up.
    const spy = makeSpy({
      ok: true,
      exitCode: 1,
      stdout: "",
      stderr: "rate limit exceeded (429)",
    });
    const { host } = makeInstalledHost();
    const adapter = new ClaudeAdapter({ host, spawn: spy.spawn });

    let err: unknown;
    try {
      await adapter.ask(sampleAsk());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ClaudeAdapterError);
    expect(spy.calls.length).toBe(3);
  });
});

// ---------- capped timeout retry ----------

describe("ClaudeAdapter capped timeout retry (SPEC §7)", () => {
  test("three timeouts -> terminal; timeouts are base, +50%, base", async () => {
    const spy = makeSpy({ ok: false, reason: "timeout" });
    const { host } = makeInstalledHost();
    const adapter = new ClaudeAdapter({ host, spawn: spy.spawn });

    let err: unknown;
    try {
      await adapter.ask({
        prompt: "slow",
        context: "",
        opts: { effort: "max", timeout: 1000 },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ClaudeAdapterError);
    if (err instanceof ClaudeAdapterError) {
      expect(err.payload.reason).toBe("timeout");
      expect(err.payload.kind).toBe("terminal");
      expect(err.payload.attempts).toBe(3);
    }
    // capped retry schedule: 1000, 1500, 1000.
    expect(spy.calls.length).toBe(3);
    expect(spy.calls[0]?.timeoutMs).toBe(1000);
    expect(spy.calls[1]?.timeoutMs).toBe(1500);
    expect(spy.calls[2]?.timeoutMs).toBe(1000);
  });
});

// ---------- critique ----------

describe("ClaudeAdapter.critique (SPEC §7)", () => {
  test("returns schema-valid findings + summary + suggested_next_version", async () => {
    const spy = makeFakeCliSpy({
      fixture: claudeFixture("critique-happy.json"),
    });
    const { host } = makeInstalledHost();
    const adapter = new ClaudeAdapter({ host, spawn: spy.spawn });

    const out = await adapter.critique(sampleCritique());
    expect(Array.isArray(out.findings)).toBe(true);
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.summary).toBeTruthy();
    expect(out.suggested_next_version).toBeTruthy();
    expect(out.usage).toBeNull();
  });
});
