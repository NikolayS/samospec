// Copyright 2026 Nikolay Samokhvalov.

// RED tests for Issue #88 reviewer follow-up: the real codex CLI v0.120.0
// writes the banner AND the error JSON to STDERR (not stdout). Stdout is
// empty on failure. So classifyStdoutApiError(stdout) finds nothing →
// falls through to classifyExit(1, stderr) → which does not match
// "not supported" (the actual ChatGPT rejection phrase) → classifies as
// "other" → fallback chain never fires.
//
// Required fixes (1) detect invalid_request_error on EITHER stream, and
// (2) add "not supported" to classifyExit's unavailable-phrase list.

import { describe, expect, test } from "bun:test";

import { CodexAdapter, CodexAdapterError } from "../../src/adapter/codex.ts";
import type { AskInput, EffortLevel } from "../../src/adapter/types.ts";
import type { SpawnCliInput, SpawnCliResult } from "../../src/adapter/spawn.ts";

// ---------- helpers ----------

interface SpawnSpy {
  readonly spawn: (input: SpawnCliInput) => Promise<SpawnCliResult>;
  readonly calls: { cmd: readonly string[] }[];
}

function makeSpy(responses: readonly SpawnCliResult[]): SpawnSpy {
  const calls: { cmd: readonly string[] }[] = [];
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

/**
 * The REAL codex CLI v0.120.0 output shape under ChatGPT-auth rejection:
 * - stdout: EMPTY
 * - stderr: banner lines + the invalid_request_error JSON
 * - exit: 1
 */
function realCodexStderrErrorResponse(model: string): SpawnCliResult {
  const banner =
    "OpenAI Codex v0.120.0 (research preview)\n" +
    "--------\n" +
    "workdir: /private/tmp/x\n" +
    `model: ${model}\n` +
    "provider: openai\n" +
    "approval: never\n" +
    "sandbox: read-only\n" +
    "reasoning effort: high\n" +
    "reasoning summaries: none\n" +
    "session id: abc123\n" +
    "--------\n";
  const errorJson =
    "ERROR: " +
    JSON.stringify({
      type: "error",
      status: 400,
      error: {
        type: "invalid_request_error",
        message: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
      },
    }) +
    "\n";
  return {
    ok: true,
    exitCode: 1,
    stdout: "",
    stderr: banner + errorJson,
  };
}

// ---------- Bug #88 follow-up (1): stderr-carried error JSON ----------

describe("Bug #88-followup: invalid_request_error on STDERR → model_unavailable", () => {
  test(
    "empty stdout + stderr-carried invalid_request_error (exit 1) classifies as model_unavailable",
    async () => {
      const spy = makeSpy([realCodexStderrErrorResponse("gpt-5.1-codex-max")]);
      const adapter = new CodexAdapter({
        host: FAKE_HOST,
        spawn: spy.spawn,
        binary: "/usr/bin/codex",
        models: [{ id: "gpt-5.1-codex-max", family: "codex" }],
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
        // Must classify as model_unavailable, NOT other/schema_violation.
        expect(err.payload.reason).toBe("model_unavailable");
        expect(err.payload.reason).not.toBe("other");
        expect(err.payload.reason).not.toBe("schema_violation");
      }
    },
  );

  test(
    "stderr-carried error with 'not supported' phrase triggers full fallback chain to account-default",
    async () => {
      const spy = makeSpy([
        realCodexStderrErrorResponse("gpt-5.1-codex-max"),
        realCodexStderrErrorResponse("gpt-5.1-codex"),
        {
          ok: true,
          exitCode: 0,
          stdout:
            '{"answer":"account-default-ok","usage":null,"effort_used":"high"}',
          stderr: "",
        },
      ]);
      const adapter = new CodexAdapter({
        host: FAKE_HOST,
        spawn: spy.spawn,
        binary: "/usr/bin/codex",
      });

      const out = await adapter.ask(sampleAsk());
      expect(out.answer).toBe("account-default-ok");
      expect((out as Record<string, unknown>)["account_default"]).toBe(true);

      // Three spawns: pinned-max (fail on stderr), pinned (fail on stderr),
      // account-default (success).
      expect(spy.calls.length).toBe(3);
      // Third call has no --model flag.
      const thirdCmd = spy.calls[2]?.cmd ?? [];
      expect(thirdCmd).not.toContain("--model");
    },
  );
});

// ---------- Bug #88 follow-up (2): classifyExit "not supported" phrase ----------

describe("Bug #88-followup: classifyExit recognizes 'not supported' as model_unavailable", () => {
  test(
    "stderr plain-text 'model is not supported' (no JSON) exit-1 → model_unavailable",
    async () => {
      // Some codex error paths may emit plain-text stderr without JSON
      // wrapping. The adapter must still recognize "not supported" as a
      // model-unavailable signal.
      const spy = makeSpy([
        {
          ok: true,
          exitCode: 1,
          stdout: "",
          stderr:
            "Error: The 'gpt-5.1-codex-max' model is not supported when " +
            "using Codex with a ChatGPT account.\n",
        },
      ]);
      const adapter = new CodexAdapter({
        host: FAKE_HOST,
        spawn: spy.spawn,
        binary: "/usr/bin/codex",
        models: [{ id: "gpt-5.1-codex-max", family: "codex" }],
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
    },
  );

  test(
    "case-insensitive matching: uppercase 'Not Supported' still classified",
    async () => {
      const spy = makeSpy([
        {
          ok: true,
          exitCode: 1,
          stdout: "",
          stderr: "ERROR: The MODEL is Not Supported.\n",
        },
      ]);
      const adapter = new CodexAdapter({
        host: FAKE_HOST,
        spawn: spy.spawn,
        binary: "/usr/bin/codex",
        models: [{ id: "gpt-5.1-codex-max", family: "codex" }],
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
    },
  );
});
