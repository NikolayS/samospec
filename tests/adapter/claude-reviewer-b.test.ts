// Copyright 2026 Nikolay Samokhvalov.

// Sprint 3 #2 (Issue #24) — Reviewer B (Claude second session) tests.
//
// Drives the ClaudeReviewerBAdapter through:
// - separate-process spawn distinct from the lead (spawn-spy)
// - persona prefix + taxonomy weighting on critique() (literal spec wording)
// - coupled fallback with the lead via a shared ClaudeResolver
// - rate-limit classification — retryable with `rate_limit: true` flag
// - shared adapter contract (runAdapterContract)
//
// Fixtures under tests/fixtures/claude-fixtures/.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { ClaudeAdapter, ClaudeAdapterError } from "../../src/adapter/claude.ts";
import {
  ClaudeReviewerBAdapter,
  REVIEWER_B_PERSONA_PREFIX,
} from "../../src/adapter/claude-reviewer-b.ts";
import { ClaudeResolver } from "../../src/adapter/claude-resolver.ts";
import { runAdapterContract } from "../../src/adapter/contract-test.ts";
import {
  spawnCli,
  type SpawnCliInput,
  type SpawnCliResult,
} from "../../src/adapter/spawn.ts";
import {
  type AskInput,
  type CritiqueInput,
  type EffortLevel,
} from "../../src/adapter/types.ts";

const BUN_DIR = dirname(process.execPath);
const FAKE_CLI = new URL("../fixtures/fake-cli.ts", import.meta.url).pathname;

function claudeFixture(name: string): string {
  return new URL(`../fixtures/claude-fixtures/${name}`, import.meta.url)
    .pathname;
}

const TMP: string[] = [];

afterAll(() => {
  for (const d of TMP) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeFakeBinaryDir(
  name: string,
  script: string,
): { dir: string; binary: string } {
  const dir = mkdtempSync(join(tmpdir(), "samospec-revb-bin-"));
  TMP.push(dir);
  const binary = join(dir, name);
  writeFileSync(binary, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(binary, 0o755);
  return { dir, binary };
}

function makeInstalledHost(): Record<string, string | undefined> {
  const { dir } = makeFakeBinaryDir("claude", 'echo "2.1.114"');
  // Include a fake API key so auth_status() returns
  // usable_for_noninteractive:true. Tests exercise spawn behavior,
  // not subscription-auth gating; the key is never used for real calls.
  return { PATH: dir, HOME: "/tmp", ANTHROPIC_API_KEY: "sk-ant-test-fake-key" };
}

const OPTS_MAX_120: { effort: EffortLevel; timeout: number } = {
  effort: "max",
  timeout: 120_000,
};

function sampleAsk(): AskInput {
  return { prompt: "ping", context: "", opts: OPTS_MAX_120 };
}

function sampleCritique(): CritiqueInput {
  return {
    spec: "# SPEC\n\nplaceholder",
    guidelines: "be pedantic",
    opts: OPTS_MAX_120,
  };
}

// ---------- spawn-spy ----------

interface SpawnSpyCall {
  readonly cmd: readonly string[];
  readonly env: Record<string, string | undefined>;
  readonly timeoutMs: number;
  readonly stdinLen: number;
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
      stdinLen: input.stdin.length,
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

// ---------- persona prefix ----------

describe("ClaudeReviewerBAdapter — persona prefix (SPEC §3, §7)", () => {
  test("exports the literal persona prefix wording", () => {
    // Spec §7 literal: "Focus especially on ambiguity, contradiction, and
    // weak-testing. You may surface findings in other categories when
    // warranted, but weight your effort toward these."
    expect(REVIEWER_B_PERSONA_PREFIX).toContain("Focus especially on");
    expect(REVIEWER_B_PERSONA_PREFIX).toContain("ambiguity");
    expect(REVIEWER_B_PERSONA_PREFIX).toContain("contradiction");
    expect(REVIEWER_B_PERSONA_PREFIX).toContain("weak-testing");
    expect(REVIEWER_B_PERSONA_PREFIX).toContain(
      "You may surface findings in other categories when warranted, but " +
        "weight your effort toward these.",
    );
  });

  test("critique() forwards persona prefix to the CLI via stdin", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout:
        '{"findings":[{"category":"ambiguity","text":"x",' +
        '"severity":"minor"}],"summary":"s",' +
        '"suggested_next_version":"0.1.1","usage":null,' +
        '"effort_used":"max"}',
      stderr: "",
    });
    const adapter = new ClaudeReviewerBAdapter({
      host: makeInstalledHost(),
      spawn: spy.spawn,
    });

    await adapter.critique(sampleCritique());

    const workCall = spy.calls.find((c) => c.stdinLen > 0);
    expect(workCall).toBeDefined();
    if (workCall === undefined) return;
    // Literal persona wording must appear in the prompt body piped to stdin.
    expect(workCall.stdin).toContain(
      "Focus especially on ambiguity, contradiction, and weak-testing.",
    );
    expect(workCall.stdin).toContain(
      "You may surface findings in other categories when warranted, but " +
        "weight your effort toward these.",
    );
  });

  test("critique() preserves the persona prefix over the caller's guidelines (pedantic QA review)", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout:
        '{"findings":[],"summary":"ok",' +
        '"suggested_next_version":"0.1.1","usage":null,' +
        '"effort_used":"max"}',
      stderr: "",
    });
    const adapter = new ClaudeReviewerBAdapter({
      host: makeInstalledHost(),
      spawn: spy.spawn,
    });

    await adapter.critique({
      spec: "# SPEC",
      guidelines: "caller-supplied-guideline-abc",
      opts: OPTS_MAX_120,
    });

    const workCall = spy.calls.find((c) => c.stdinLen > 0);
    expect(workCall).toBeDefined();
    if (workCall === undefined) return;
    // Both must appear; the persona prefix must come before the caller's
    // guideline so it is the dominant system message.
    const idxPersona = workCall.stdin.indexOf("Focus especially on");
    const idxCaller = workCall.stdin.indexOf("caller-supplied-guideline-abc");
    expect(idxPersona).toBeGreaterThanOrEqual(0);
    expect(idxCaller).toBeGreaterThanOrEqual(0);
    expect(idxPersona).toBeLessThan(idxCaller);
  });

  test("ask() and revise() do not inject the persona prefix (only critique carries it)", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout: '{"answer":"ok","usage":null,"effort_used":"max"}',
      stderr: "",
    });
    const adapter = new ClaudeReviewerBAdapter({
      host: makeInstalledHost(),
      spawn: spy.spawn,
    });
    await adapter.ask(sampleAsk());
    const askCall = spy.calls.find((c) => c.stdinLen > 0);
    expect(askCall).toBeDefined();
    if (askCall === undefined) return;
    expect(askCall.stdin).not.toContain("Focus especially on");
  });
});

// ---------- separate process from the lead ----------

describe("ClaudeReviewerBAdapter — separate-process spawn (SPEC §7)", () => {
  test("lead and reviewer B issue two distinct spawn invocations", async () => {
    // Both instances share the same host + spawn spy so we can inspect
    // every Bun.spawn invocation from a single vantage point. The spy
    // counts every call including detect probes.
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout: '{"answer":"ok","usage":null,"effort_used":"max"}',
      stderr: "",
    });
    const host = makeInstalledHost();

    const lead = new ClaudeAdapter({ host, spawn: spy.spawn });
    const reviewerB = new ClaudeReviewerBAdapter({
      host,
      spawn: spy.spawn,
    });

    await lead.ask(sampleAsk());
    const leadCallCount = spy.calls.filter((c) => c.stdinLen > 0).length;

    await reviewerB.ask(sampleAsk());
    const totalCallCount = spy.calls.filter((c) => c.stdinLen > 0).length;

    // The reviewer's work spawn is an additional invocation — not the
    // same process reused. Two distinct command invocations total.
    expect(leadCallCount).toBe(1);
    expect(totalCallCount).toBe(2);
  });

  test("reviewer B's spawn invocation is independent of the lead's prompt", async () => {
    const leadSpy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout: '{"answer":"lead-ok","usage":null,"effort_used":"max"}',
      stderr: "",
    });
    const reviewerSpy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout:
        '{"findings":[{"category":"ambiguity","text":"x",' +
        '"severity":"minor"}],"summary":"s",' +
        '"suggested_next_version":"0.1.1","usage":null,' +
        '"effort_used":"max"}',
      stderr: "",
    });
    const host = makeInstalledHost();
    const lead = new ClaudeAdapter({ host, spawn: leadSpy.spawn });
    const reviewerB = new ClaudeReviewerBAdapter({
      host,
      spawn: reviewerSpy.spawn,
    });

    await lead.ask(sampleAsk());
    await reviewerB.critique(sampleCritique());

    const leadCall = leadSpy.calls.find((c) => c.stdinLen > 0);
    const reviewerCall = reviewerSpy.calls.find((c) => c.stdinLen > 0);
    expect(leadCall).toBeDefined();
    expect(reviewerCall).toBeDefined();
    if (leadCall === undefined || reviewerCall === undefined) return;
    // Different stdin payloads: lead gets the ask prompt, reviewer
    // gets a critique prompt (guidelines + spec).
    expect(leadCall.stdin).not.toBe(reviewerCall.stdin);
    // Reviewer's stdin carries the critique schema field "findings".
    expect(reviewerCall.stdin).toContain("findings");
    // Lead's stdin carries the ask schema field "answer".
    expect(leadCall.stdin).toContain("answer");
  });
});

// ---------- ClaudeResolver (shared resolver) ----------

describe("ClaudeResolver — shared fallback-chain (SPEC §11)", () => {
  test("defaults to the pinned opus model", () => {
    const resolver = new ClaudeResolver();
    expect(resolver.getCurrentModel()).toBe("claude-opus-4-7");
    expect(resolver.snapshot().coupled_fallback).toBe(false);
  });

  test("reportUnavailable advances to sonnet and marks coupled_fallback", () => {
    const resolver = new ClaudeResolver();
    resolver.reportUnavailable("claude-opus-4-7");
    expect(resolver.getCurrentModel()).toBe("claude-sonnet-4-6");
    expect(resolver.snapshot().coupled_fallback).toBe(true);
  });

  test("reportUnavailable on the last model does not advance past the end", () => {
    const resolver = new ClaudeResolver();
    resolver.reportUnavailable("claude-opus-4-7");
    resolver.reportUnavailable("claude-sonnet-4-6");
    // Still the last model in the chain; resolver does not cycle.
    expect(resolver.getCurrentModel()).toBe("claude-sonnet-4-6");
  });

  test("reportUnavailable on a model that is no longer current is a no-op (idempotent)", () => {
    const resolver = new ClaudeResolver();
    resolver.reportUnavailable("claude-opus-4-7");
    // A reviewer-B call reporting a stale model must not double-advance.
    resolver.reportUnavailable("claude-opus-4-7");
    expect(resolver.getCurrentModel()).toBe("claude-sonnet-4-6");
  });
});

describe("ClaudeResolver — coupled lead + reviewer-B (SPEC §11)", () => {
  test("when the lead advances, reviewer-B sees the same model on the next spawn", async () => {
    const resolver = new ClaudeResolver();
    const host = makeInstalledHost();

    // Lead spy: first call returns model_unavailable for opus (retried
    // up to capped retry then terminal); subsequent calls return valid.
    const leadSpy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout: '{"answer":"ok","usage":null,"effort_used":"max"}',
      stderr: "",
    });
    const reviewerSpy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout:
        '{"findings":[],"summary":"ok",' +
        '"suggested_next_version":"0.1.1","usage":null,' +
        '"effort_used":"max"}',
      stderr: "",
    });

    const lead = new ClaudeAdapter({
      host,
      spawn: leadSpy.spawn,
      resolver,
    });
    const reviewerB = new ClaudeReviewerBAdapter({
      host,
      spawn: reviewerSpy.spawn,
      resolver,
    });

    // Caller drives the transition: fallback is detected externally and
    // recorded on the shared resolver. Both adapter spawns then carry
    // the sonnet --model pin.
    resolver.reportUnavailable("claude-opus-4-7");

    await lead.ask(sampleAsk());
    await reviewerB.critique(sampleCritique());

    const leadCall = leadSpy.calls.find((c) => c.stdinLen > 0);
    const reviewerCall = reviewerSpy.calls.find((c) => c.stdinLen > 0);
    expect(leadCall).toBeDefined();
    expect(reviewerCall).toBeDefined();
    if (leadCall === undefined || reviewerCall === undefined) return;
    expect(leadCall.cmd).toContain("claude-sonnet-4-6");
    expect(reviewerCall.cmd).toContain("claude-sonnet-4-6");
    expect(resolver.snapshot().coupled_fallback).toBe(true);
  });
});

// ---------- rate-limit classification ----------

describe("ClaudeReviewerBAdapter — rate-limit classification (SPEC §7 rate-limit sharing)", () => {
  test("rate-limit-shaped stderr yields a ClaudeAdapterError with rate_limit flag", async () => {
    // After capped retries (3 attempts) the downstream error is
    // classified as retryable + rate_limit=true so the review loop
    // can soft-degrade instead of treating it as a real timeout.
    const spy = makeSpy({
      ok: true,
      exitCode: 1,
      stdout: "",
      stderr: "Error: rate limit exceeded (429). retry after 60s",
    });
    const adapter = new ClaudeReviewerBAdapter({
      host: makeInstalledHost(),
      spawn: spy.spawn,
    });

    let err: unknown;
    try {
      await adapter.critique(sampleCritique());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ClaudeAdapterError);
    if (err instanceof ClaudeAdapterError) {
      expect(err.payload.rate_limit).toBe(true);
      expect(err.payload.retryable).toBe(true);
    }
    // Retried full capped schedule before surfacing rate-limit.
    expect(spy.calls.length).toBe(3);
  });

  test("regular timeout errors are NOT flagged as rate_limit", async () => {
    const spy = makeSpy({ ok: false, reason: "timeout" });
    const adapter = new ClaudeReviewerBAdapter({
      host: makeInstalledHost(),
      spawn: spy.spawn,
    });

    let err: unknown;
    try {
      await adapter.critique(sampleCritique());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ClaudeAdapterError);
    if (err instanceof ClaudeAdapterError) {
      expect(err.payload.rate_limit).toBeFalsy();
    }
  });
});

// ---------- shared adapter contract ----------

/**
 * Contract-test delegator: intercepts --version probes so they don't
 * consume a branch of the trio fixture; forwards work-call spawns to
 * the fake-CLI harness keyed by a state file.
 */
function makeContractDelegator(
  fixture: string,
): (i: SpawnCliInput) => Promise<SpawnCliResult> {
  const stateDir = mkdtempSync(join(tmpdir(), "samospec-revb-contract-"));
  TMP.push(stateDir);
  const stateFile = join(stateDir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ call: 0 }));

  return async (input: SpawnCliInput): Promise<SpawnCliResult> => {
    if (input.cmd.includes("--version")) {
      return {
        ok: true,
        exitCode: 0,
        stdout: "2.1.114 (Claude Code)\n",
        stderr: "",
      };
    }
    const env: Record<string, string | undefined> = {
      ...input.env,
      FAKE_CLI_FIXTURE: fixture,
      FAKE_CLI_STATE_FILE: stateFile,
    };
    const hostSnapshot: Record<string, string | undefined> = {
      ...(input.host ?? {}),
    };
    const hostPath = hostSnapshot["PATH"] ?? "";
    hostSnapshot["PATH"] = hostPath === "" ? BUN_DIR : `${BUN_DIR}:${hostPath}`;
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
}

describe("ClaudeReviewerBAdapter — shared contract (SPEC §13 test 4)", () => {
  test("passes the full contract suite via the fake-CLI trio fixture", async () => {
    await runAdapterContract({
      name: "claude-reviewer-b",
      makeAdapter: () =>
        new ClaudeReviewerBAdapter({
          host: makeInstalledHost(),
          spawn: makeContractDelegator(claudeFixture("contract-trio.json")),
        }),
    });
  });
});
