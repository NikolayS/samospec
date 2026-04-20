// Copyright 2026 Nikolay Samokhvalov.

// Work-call tests for the Codex adapter (Reviewer A seat). Mirrors
// tests/adapter/claude.work.test.ts but for the `codex` CLI and the
// security/ops persona (SPEC §7 Model roles, §11).
//
// Covers:
// - auth_status: subscription_auth detection both branches
//   (OPENAI_API_KEY present -> false, absent -> true)
// - spawn-spy: non-interactive flags (`exec`) passed on every work call
// - spawn-spy: minimal env — only HOME, PATH, TMPDIR, OPENAI_API_KEY
//   forwarded; no host secret leaks
// - spawn-spy: pinned model `gpt-5.1-codex-max` passed on first attempt
// - spawn-spy: reasoning-effort flag matches the logical effort per
//   SPEC §11 effort-level table
// - critique(): persona system prompt + taxonomy weighting literal
//   wording present in the stdin prompt
// - schema-violation repair: one retry, then terminal
// - usage: null default when CLI omits it
// - revise() returns { ready, rationale }
// - capped timeout retry (base -> +50% -> base -> terminal)
// - exit-code classification (rate-limit retries, auth terminal)
// - Markdown-code-fence stripping end-to-end
// - Model fallback chain: first model refused -> second model tried
//
// Fixtures live under tests/fixtures/codex-fixtures/.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CodexAdapter, CodexAdapterError } from "../../src/adapter/codex.ts";
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

const BUN_DIR = dirname(process.execPath);
const FAKE_CLI = new URL("../fixtures/fake-cli.ts", import.meta.url).pathname;

function codexFixture(name: string): string {
  return new URL(`../fixtures/codex-fixtures/${name}`, import.meta.url)
    .pathname;
}

const TMP: string[] = [];

function makeFakeBinaryDir(
  name: string,
  script: string,
): { dir: string; binary: string } {
  const dir = mkdtempSync(join(tmpdir(), "samospec-codex-bin-"));
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
  readonly stdin: string;
  readonly extraAllowedEnvKeys: readonly string[];
}

interface SpawnSpy {
  readonly spawn: (input: SpawnCliInput) => Promise<SpawnCliResult>;
  readonly calls: SpawnSpyCall[];
}

function makeSpy(
  scripted: SpawnCliResult | readonly SpawnCliResult[],
): SpawnSpy {
  const calls: SpawnSpyCall[] = [];
  const spawn = (input: SpawnCliInput): Promise<SpawnCliResult> => {
    calls.push({
      cmd: [...input.cmd],
      env: { ...input.env },
      timeoutMs: input.timeoutMs,
      stdin: input.stdin,
      extraAllowedEnvKeys: [...(input.extraAllowedEnvKeys ?? [])],
    });
    const result = Array.isArray(scripted)
      ? (scripted[calls.length - 1] ?? scripted[scripted.length - 1]!)
      : (scripted as SpawnCliResult);
    return Promise.resolve(result);
  };
  return { spawn, calls };
}

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
      stdin: input.stdin,
      extraAllowedEnvKeys: [...(input.extraAllowedEnvKeys ?? [])],
    });
    const env: Record<string, string | undefined> = {
      ...input.env,
      FAKE_CLI_FIXTURE: opts.fixture,
    };
    if (opts.stateFile !== undefined) {
      env["FAKE_CLI_STATE_FILE"] = opts.stateFile;
    }
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

const OPTS_HIGH_120: { effort: EffortLevel; timeout: number } = {
  effort: "high",
  timeout: 120_000,
};

function makeInstalledHost(): {
  host: Record<string, string | undefined>;
  binaryPath: string;
} {
  const { dir, binary } = makeFakeBinaryDir("codex", 'echo "0.41.0"');
  return {
    host: { PATH: dir, HOME: "/tmp" },
    binaryPath: binary,
  };
}

function sampleAsk(): AskInput {
  return { prompt: "ping", context: "", opts: OPTS_HIGH_120 };
}
function sampleCritique(): CritiqueInput {
  return {
    spec: "# SPEC\n\nplaceholder",
    guidelines: "be paranoid",
    opts: OPTS_HIGH_120,
  };
}
function sampleRevise(): ReviseInput {
  return {
    spec: "# SPEC\n\nplaceholder",
    reviews: [],
    decisions_history: [],
    opts: OPTS_HIGH_120,
  };
}

// ---------- auth_status ----------

describe("CodexAdapter.auth_status (SPEC §11 subscription-auth)", () => {
  test("no binary on PATH -> { authenticated: false }", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "samospec-codex-empty-"));
    TMP.push(emptyDir);
    const adapter = new CodexAdapter({
      host: { PATH: emptyDir, HOME: "/tmp" },
    });
    const result = await adapter.auth_status();
    expect(result.authenticated).toBe(false);
  });

  test("binary present + OPENAI_API_KEY set -> subscription_auth=false", async () => {
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({
      host: { ...host, OPENAI_API_KEY: "sk-test-not-a-real-key" },
    });
    const result = await adapter.auth_status();
    expect(result.authenticated).toBe(true);
    expect(result.subscription_auth).toBe(false);
  });

  test("binary present + no API key -> subscription_auth=true (ChatGPT login assumed)", async () => {
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host });
    const result = await adapter.auth_status();
    expect(result.authenticated).toBe(true);
    expect(result.subscription_auth).toBe(true);
  });
});

// ---------- spawn-spy: non-interactive flags + env + model pin ----------

describe("CodexAdapter spawn flags + minimal env (SPEC §7)", () => {
  test("ask() passes `exec` subcommand and --model pin", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout: '{"answer":"ok","usage":null,"effort_used":"high"}',
      stderr: "",
    });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host, spawn: spy.spawn });

    await adapter.ask(sampleAsk());

    const workCall = spy.calls.find((c) => c.stdin.length > 0);
    expect(workCall).toBeDefined();
    if (workCall === undefined) return;
    expect(workCall.cmd).toContain("exec");
    expect(workCall.cmd).toContain("--model");
    expect(workCall.cmd).toContain("gpt-5.1-codex-max");
  });

  test("ask() passes reasoning_effort flag matching logical effort (SPEC §11 table)", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout: '{"answer":"ok","usage":null,"effort_used":"high"}',
      stderr: "",
    });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host, spawn: spy.spawn });

    await adapter.ask({
      prompt: "ping",
      context: "",
      opts: { effort: "high", timeout: 120_000 },
    });

    const workCall = spy.calls.find((c) => c.stdin.length > 0);
    expect(workCall).toBeDefined();
    if (workCall === undefined) return;
    // Effort mapping per SPEC §11: logical 'high' -> reasoning_effort high
    const cmdJoined = workCall.cmd.join(" ");
    expect(cmdJoined).toContain("high");
    // The flag itself must be present.
    expect(workCall.cmd.some((c) => c.includes("reasoning"))).toBe(true);
  });

  test("work-call spawn forwards OPENAI_API_KEY via extraAllowedEnvKeys", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout: '{"answer":"ok","usage":null,"effort_used":"high"}',
      stderr: "",
    });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({
      host: { ...host, TMPDIR: "/tmp", OPENAI_API_KEY: "sk-test" },
      spawn: spy.spawn,
    });
    await adapter.ask(sampleAsk());

    const workCall = spy.calls.find((c) => c.stdin.length > 0);
    expect(workCall).toBeDefined();
    if (workCall === undefined) return;
    expect(workCall.extraAllowedEnvKeys).toContain("OPENAI_API_KEY");
  });

  test("end-to-end minimal-env: fake-CLI child sees only allowlist keys (no host leaks)", async () => {
    const echoEnv = new URL(
      "../fixtures/fake-cli-fixtures/echo-env.json",
      import.meta.url,
    ).pathname;
    let capturedKeys: readonly string[] = [];

    const peekSpawn = async (input: SpawnCliInput): Promise<SpawnCliResult> => {
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
      return {
        ok: true,
        exitCode: 0,
        stdout: '{"answer":"ok","usage":null,"effort_used":"high"}',
        stderr: "",
      };
    };

    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({
      host: {
        ...host,
        TMPDIR: "/tmp",
        OPENAI_API_KEY: "sk-forwarded-value",
        ANTHROPIC_API_KEY: "not-leaked",
        LEAKY_HOST_SECRET: "nope",
      },
      spawn: peekSpawn,
    });

    await adapter.ask(sampleAsk());

    // Allowlist: HOME, PATH, TMPDIR, OPENAI_API_KEY
    // (+ FAKE_CLI_FIXTURE for the peek harness).
    expect(capturedKeys).toContain("OPENAI_API_KEY");
    expect(capturedKeys).not.toContain("ANTHROPIC_API_KEY");
    expect(capturedKeys).not.toContain("LEAKY_HOST_SECRET");
  });

  test("revise() returns ready + rationale from JSON body", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout:
        '{"spec":"# SPEC\\n\\nrevised.","ready":false,' +
        '"rationale":"reviewer rarely revises","usage":null,"effort_used":"high"}',
      stderr: "",
    });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host, spawn: spy.spawn });

    const out = await adapter.revise(sampleRevise());
    expect(out.ready).toBe(false);
    expect(out.rationale).toBe("reviewer rarely revises");
    expect(out.spec).toContain("# SPEC");
    expect(out.usage).toBeNull();
  });

  test("usage defaults to null when CLI omits it", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout: '{"answer":"no usage info"}',
      stderr: "",
    });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host, spawn: spy.spawn });
    const out = await adapter.ask(sampleAsk());
    expect(out.usage).toBeNull();
    expect(out.effort_used).toBe("high");
  });
});

// ---------- persona system prompt + taxonomy weighting ----------

describe("CodexAdapter.critique persona prefix (SPEC §7 Model roles)", () => {
  test("critique stdin contains paranoid security/ops persona", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout:
        '{"findings":[],"summary":"ok","suggested_next_version":"0.1.0",' +
        '"usage":null,"effort_used":"high"}',
      stderr: "",
    });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host, spawn: spy.spawn });

    await adapter.critique(sampleCritique());

    const workCall = spy.calls.find((c) => c.stdin.length > 0);
    expect(workCall).toBeDefined();
    if (workCall === undefined) return;
    // Persona must identify as paranoid security/ops engineer (SPEC §7).
    expect(workCall.stdin.toLowerCase()).toContain("paranoid");
    expect(workCall.stdin.toLowerCase()).toContain("security");
  });

  test("critique stdin contains literal taxonomy-weighting wording (SPEC §7)", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout:
        '{"findings":[],"summary":"ok","suggested_next_version":"0.1.0",' +
        '"usage":null,"effort_used":"high"}',
      stderr: "",
    });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host, spawn: spy.spawn });

    await adapter.critique(sampleCritique());

    const workCall = spy.calls.find((c) => c.stdin.length > 0);
    expect(workCall).toBeDefined();
    if (workCall === undefined) return;
    // Literal wording from issue #23 (advisory, not a hard filter).
    const literal =
      "Focus especially on missing-risk, weak-implementation, and " +
      "unnecessary-scope. You may surface findings in other categories " +
      "when warranted, but weight your effort toward these.";
    expect(workCall.stdin).toContain(literal);
  });

  test("ask() does NOT contain the persona prefix (critique-only)", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout: '{"answer":"ok","usage":null,"effort_used":"high"}',
      stderr: "",
    });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host, spawn: spy.spawn });

    await adapter.ask(sampleAsk());

    const workCall = spy.calls.find((c) => c.stdin.length > 0);
    expect(workCall).toBeDefined();
    if (workCall === undefined) return;
    expect(workCall.stdin.toLowerCase()).not.toContain("paranoid");
  });
});

// ---------- schema-violation repair (end-to-end via fake-CLI) ----------

describe("CodexAdapter schema-violation repair (SPEC §7)", () => {
  test("happy ask(): fake-CLI emits valid JSON once", async () => {
    const spy = makeFakeCliSpy({
      fixture: codexFixture("ask-happy.json"),
    });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host, spawn: spy.spawn });
    const out = await adapter.ask(sampleAsk());
    expect(out.answer).toBe("hello from codex");
    expect(out.usage).toBeNull();
  });

  test("schema-violation then repair: first call garbage, second valid", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "samospec-codex-state-"));
    TMP.push(stateDir);
    const stateJson = join(stateDir, "call-state.json");
    writeFileSync(stateJson, JSON.stringify({ call: 0 }));

    const spy = makeFakeCliSpy({
      fixture: codexFixture("ask-schema-repair.json"),
      stateFile: stateJson,
    });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host, spawn: spy.spawn });

    const out = await adapter.ask(sampleAsk());
    expect(out.answer).toBe("repaired");
    // Exactly two spawns: one bad, one repair.
    expect(spy.calls.length).toBe(2);
  });

  test("schema-violation twice: terminal after ONE repair retry", async () => {
    const spy = makeFakeCliSpy({
      fixture: codexFixture("ask-schema-fatal.json"),
    });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host, spawn: spy.spawn });

    let err: unknown;
    try {
      await adapter.ask(sampleAsk());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodexAdapterError);
    if (err instanceof CodexAdapterError) {
      expect(err.payload.reason).toBe("schema_violation");
      expect(err.payload.kind).toBe("terminal");
    }
    expect(spy.calls.length).toBe(2);
  });

  test("Markdown-fenced JSON is stripped and validated end-to-end", async () => {
    const spy = makeFakeCliSpy({
      fixture: codexFixture("ask-fenced.json"),
    });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host, spawn: spy.spawn });

    const out = await adapter.ask(sampleAsk());
    expect(out.answer).toBe("fenced-ok");
    expect(out.usage).toBeNull();
  });
});

// ---------- exit-code classification ----------

describe("CodexAdapter exit-code classification (SPEC §7)", () => {
  test("non-zero exit with auth stderr -> terminal error, no retry", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 2,
      stdout: "",
      stderr: "unauthorized: no OPENAI_API_KEY",
    });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host, spawn: spy.spawn });

    let err: unknown;
    try {
      await adapter.ask(sampleAsk());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodexAdapterError);
    if (err instanceof CodexAdapterError) {
      expect(err.payload.kind).toBe("terminal");
      expect(err.payload.reason).toBe("other");
    }
    expect(spy.calls.length).toBe(1);
  });

  test("non-zero exit with rate-limit stderr -> retried as timeout class", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 1,
      stdout: "",
      stderr: "rate limit exceeded (429)",
    });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host, spawn: spy.spawn });

    let err: unknown;
    try {
      await adapter.ask(sampleAsk());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodexAdapterError);
    expect(spy.calls.length).toBe(3);
  });
});

// ---------- capped timeout retry ----------

describe("CodexAdapter capped timeout retry (SPEC §7)", () => {
  test("three timeouts -> terminal; timeouts are base, +50%, base", async () => {
    const spy = makeSpy({ ok: false, reason: "timeout" });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host, spawn: spy.spawn });

    let err: unknown;
    try {
      await adapter.ask({
        prompt: "slow",
        context: "",
        opts: { effort: "high", timeout: 1000 },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodexAdapterError);
    if (err instanceof CodexAdapterError) {
      expect(err.payload.reason).toBe("timeout");
      expect(err.payload.kind).toBe("terminal");
      expect(err.payload.attempts).toBe(3);
    }
    expect(spy.calls.length).toBe(3);
    expect(spy.calls[0]?.timeoutMs).toBe(1000);
    expect(spy.calls[1]?.timeoutMs).toBe(1500);
    expect(spy.calls[2]?.timeoutMs).toBe(1000);
  });
});

// ---------- critique schema ----------

describe("CodexAdapter.critique (SPEC §7)", () => {
  test("returns schema-valid findings + summary + suggested_next_version", async () => {
    const spy = makeFakeCliSpy({
      fixture: codexFixture("critique-happy.json"),
    });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host, spawn: spy.spawn });

    const out = await adapter.critique(sampleCritique());
    expect(Array.isArray(out.findings)).toBe(true);
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.summary).toBeTruthy();
    expect(out.suggested_next_version).toBeTruthy();
    expect(out.usage).toBeNull();
  });
});

// ---------- model fallback chain ----------

describe("CodexAdapter model fallback (SPEC §11)", () => {
  test("pinned model rejected -> falls back to gpt-5.1-codex and succeeds", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "samospec-codex-fb-"));
    TMP.push(stateDir);
    const stateJson = join(stateDir, "call-state.json");
    writeFileSync(stateJson, JSON.stringify({ call: 0 }));

    const spy = makeFakeCliSpy({
      fixture: codexFixture("model-fallback.json"),
      stateFile: stateJson,
    });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host, spawn: spy.spawn });

    const out = await adapter.ask(sampleAsk());
    expect(out.answer).toBe("fallback-ok");
    // Exactly two spawns: max (rejected), then codex.
    expect(spy.calls.length).toBe(2);
    // First call carried the pinned model.
    const firstCmd = spy.calls[0]?.cmd.join(" ") ?? "";
    expect(firstCmd).toContain("gpt-5.1-codex-max");
    // Second call carried the fallback model.
    const secondCmd = spy.calls[1]?.cmd.join(" ") ?? "";
    expect(secondCmd).toContain("gpt-5.1-codex");
    expect(secondCmd).not.toContain("gpt-5.1-codex-max");
  });

  test("all models rejected -> terminal", async () => {
    const spy = makeFakeCliSpy({
      fixture: codexFixture("model-fallback-all-fail.json"),
    });
    const { host } = makeInstalledHost();
    const adapter = new CodexAdapter({ host, spawn: spy.spawn });

    let err: unknown;
    try {
      await adapter.ask(sampleAsk());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodexAdapterError);
    if (err instanceof CodexAdapterError) {
      expect(err.payload.kind).toBe("terminal");
      expect(err.payload.reason).toBe("model_unavailable");
    }
    // Both models were attempted.
    expect(spy.calls.length).toBe(2);
  });
});
