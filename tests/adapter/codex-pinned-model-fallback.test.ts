// Copyright 2026 Nikolay Samokhvalov.

// RED tests for Issue #88 Bug 1: pinned-model fallback doesn't trigger
// for ChatGPT `invalid_request_error` when exit code is 1.
//
// The real Codex CLI returns exit 1 + stdout JSON with
// `invalid_request_error` + "not supported when using Codex with a
// ChatGPT account" when a pinned model is rejected. The adapter
// currently calls classifyExit(1, stderr) which looks only at stderr
// (empty) and classifies as "other" — the fallback never fires.
//
// Fix: classifyStdoutApiError must be checked BEFORE classifyExit on
// non-zero exit codes so that stdout-carried error JSON wins.

import { describe, expect, test } from "bun:test";

import { CodexAdapter, CodexAdapterError } from "../../src/adapter/codex.ts";
import type { AskInput, EffortLevel } from "../../src/adapter/types.ts";
import type { SpawnCliInput, SpawnCliResult } from "../../src/adapter/spawn.ts";

// ---------- spy helpers ----------

interface SpawnSpyCall {
  readonly cmd: readonly string[];
}

interface SpawnSpy {
  readonly spawn: (input: SpawnCliInput) => Promise<SpawnCliResult>;
  readonly calls: SpawnSpyCall[];
}

function makeSpy(responses: readonly SpawnCliResult[]): SpawnSpy {
  const calls: SpawnSpyCall[] = [];
  const spawn = (input: SpawnCliInput): Promise<SpawnCliResult> => {
    calls.push({ cmd: [...input.cmd] });
    const idx = calls.length - 1;
    const result = responses[idx] ?? responses[responses.length - 1];
    if (result === undefined) {
      throw new Error(
        "makeSpy: no response configured for call " + String(idx),
      );
    }
    return Promise.resolve(result);
  };
  return { spawn, calls };
}

// ---------- constants ----------

const OPTS_HIGH: { effort: EffortLevel; timeout: number } = {
  effort: "high",
  timeout: 30_000,
};

const FAKE_HOST: Record<string, string | undefined> = {
  PATH: "/usr/bin:/bin",
  HOME: "/tmp",
};

function sampleAsk(): AskInput {
  return { prompt: "ping", context: "", opts: OPTS_HIGH };
}

// The exact payload the real Codex CLI emits when a pinned model is
// rejected under ChatGPT-account auth — exit 1, error JSON on stdout.
function makePinnedModelExit1Response(model: string): SpawnCliResult {
  return {
    ok: true,
    exitCode: 1,
    stdout:
      JSON.stringify({
        type: "error",
        status: 400,
        error: {
          type: "invalid_request_error",
          message: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
        },
      }) + "\n",
    stderr: "",
  };
}

const ACCOUNT_DEFAULT_OK: SpawnCliResult = {
  ok: true,
  exitCode: 0,
  stdout: '{"answer":"account-default-ok","usage":null,"effort_used":"high"}',
  stderr: "",
};

// ---------- Bug #88-1a: classifier must return model_unavailable ----------

describe("Bug #88-1: exit-1 + invalid_request_error stdout → model_unavailable", () => {
  test("classifies exit-1 invalid_request_error stdout as model_unavailable, not other/schema_violation", async () => {
    // Single-model, no account-default: isolates the classification.
    const spy = makeSpy([makePinnedModelExit1Response("gpt-5.4")]);
    const adapter = new CodexAdapter({
      host: FAKE_HOST,
      spawn: spy.spawn,
      binary: "/usr/bin/codex",
      models: [{ id: "gpt-5.4", family: "codex" }],
      accountDefaultFallback: false,
    });

    let err: unknown;
    try {
      await adapter.ask(sampleAsk());
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(CodexAdapterError);
    if (err instanceof CodexAdapterError) {
      // Must be model_unavailable so the fallback chain can trigger.
      expect(err.payload.reason).toBe("model_unavailable");
      // Must NOT be misclassified as schema_violation or other.
      expect(err.payload.reason).not.toBe("schema_violation");
      expect(err.payload.reason).not.toBe("other");
    }

    // Only one spawn — no spurious repair retry on model_unavailable.
    expect(spy.calls.length).toBe(1);
  });

  test("exit-1 invalid_request_error with 'not supported' substring → model_unavailable", async () => {
    const payload: SpawnCliResult = {
      ok: true,
      exitCode: 1,
      stdout:
        "Reading prompt from stdin...\nOpenAI Codex v0.120.0 (research preview)\n" +
        "--------\nworkdir: /private/tmp/x\nmodel: gpt-5.4\n--------\n" +
        JSON.stringify({
          type: "error",
          status: 400,
          error: {
            type: "invalid_request_error",
            message:
              "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
          },
        }) +
        "\n",
      stderr: "",
    };
    const spy = makeSpy([payload]);
    const adapter = new CodexAdapter({
      host: FAKE_HOST,
      spawn: spy.spawn,
      binary: "/usr/bin/codex",
      models: [{ id: "gpt-5.4", family: "codex" }],
      accountDefaultFallback: false,
    });

    let err: unknown;
    try {
      await adapter.ask(sampleAsk());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodexAdapterError);
    if (err instanceof CodexAdapterError) {
      expect(err.payload.reason).toBe("model_unavailable");
    }
  });
});

// ---------- Bug #88-1b: fallback chain must trigger ----------

describe("Bug #88-1 fallback: exit-1 invalid_request_error fires account-default fallback", () => {
  test("gpt-5.4 exit-1 → gpt-5.3-codex exit-1 → account-default (no --model) succeeds", async () => {
    const spy = makeSpy([
      makePinnedModelExit1Response("gpt-5.4"),
      makePinnedModelExit1Response("gpt-5.3-codex"),
      ACCOUNT_DEFAULT_OK,
    ]);
    const adapter = new CodexAdapter({
      host: FAKE_HOST,
      spawn: spy.spawn,
      binary: "/usr/bin/codex",
    });

    const out = await adapter.ask(sampleAsk());
    expect(out.answer).toBe("account-default-ok");

    // Three spawns: pinned-max (fail), pinned (fail), account-default (ok).
    expect(spy.calls.length).toBe(3);

    // Third call must NOT contain --model.
    const thirdCmd = spy.calls[2]?.cmd ?? [];
    expect(thirdCmd).not.toContain("--model");

    // First two calls DID contain --model.
    expect(spy.calls[0]?.cmd).toContain("--model");
    expect(spy.calls[1]?.cmd).toContain("--model");
  });

  test("exit-1 invalid_request_error with account-default succeeds → account_default: true in output", async () => {
    const spy = makeSpy([
      makePinnedModelExit1Response("gpt-5.4"),
      makePinnedModelExit1Response("gpt-5.3-codex"),
      ACCOUNT_DEFAULT_OK,
    ]);
    const adapter = new CodexAdapter({
      host: FAKE_HOST,
      spawn: spy.spawn,
      binary: "/usr/bin/codex",
    });

    const out = await adapter.ask(sampleAsk());
    expect((out as Record<string, unknown>)["account_default"]).toBe(true);
  });
});
