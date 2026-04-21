// Copyright 2026 Nikolay Samokhvalov.

// RED tests for Issue #88 Bug 2: Codex output parser doesn't handle
// agentic-wrapper output.
//
// `codex exec` emits a multi-section banner before and after the JSON:
//
//   Reading prompt from stdin...
//   OpenAI Codex v0.120.0 (research preview)
//   --------
//   workdir: /private/tmp/todo-stream
//   model: gpt-5.4
//   provider: openai
//   approval: never
//   sandbox: read-only
//   reasoning effort: high
//   reasoning summaries: none
//   session id: abc123
//   --------
//   user
//   <prompt text>
//
//   codex
//   <JSON response>
//
//   tokens used
//   2561
//
//   <JSON repeated>
//
// The fix (Option A from the spec): locate the "codex\n" marker line;
// the JSON block follows until "tokens used" or EOF. Extract it and
// feed to JSON.parse.

import { describe, expect, test } from "bun:test";

import { CodexAdapter, CodexAdapterError } from "../../src/adapter/codex.ts";
import type { AskInput, CritiqueInput, EffortLevel } from "../../src/adapter/types.ts";
import type { SpawnCliInput, SpawnCliResult } from "../../src/adapter/spawn.ts";

// ---------- fixtures ----------

const ASK_JSON = JSON.stringify({
  answer: "agentic-ok",
  usage: null,
  effort_used: "high",
});

const CRITIQUE_JSON = JSON.stringify({
  findings: [
    { category: "missing-risk", text: "no auth", severity: "major" },
  ],
  summary: "needs auth",
  suggested_next_version: "0.1.1",
  usage: null,
  effort_used: "high",
});

/**
 * Build the full agentic-wrapper stdout that codex exec emits, with
 * the given JSON payload embedded in the "codex\n<JSON>" section.
 */
function makeAgenticWrapperStdout(
  prompt: string,
  jsonPayload: string,
): string {
  return (
    "Reading prompt from stdin...\n" +
    "OpenAI Codex v0.120.0 (research preview)\n" +
    "--------\n" +
    "workdir: /private/tmp/test-repo\n" +
    "model: gpt-5.4\n" +
    "provider: openai\n" +
    "approval: never\n" +
    "sandbox: read-only\n" +
    "reasoning effort: high\n" +
    "reasoning summaries: none\n" +
    "session id: abc123def456\n" +
    "--------\n" +
    "user\n" +
    prompt +
    "\n" +
    "\n" +
    "codex\n" +
    jsonPayload +
    "\n" +
    "\n" +
    "tokens used\n" +
    "2561\n" +
    "\n" +
    jsonPayload +
    "\n"
  );
}

// ---------- spy helper ----------

interface SpawnSpy {
  readonly spawn: (input: SpawnCliInput) => Promise<SpawnCliResult>;
  readonly calls: Array<{ cmd: readonly string[] }>;
}

function makeSpy(response: SpawnCliResult): SpawnSpy {
  const calls: Array<{ cmd: readonly string[] }> = [];
  const spawn = (input: SpawnCliInput): Promise<SpawnCliResult> => {
    calls.push({ cmd: [...input.cmd] });
    return Promise.resolve(response);
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

// ---------- tests ----------

describe("Bug #88-2: agentic-wrapper stdout extraction (Option A)", () => {
  test(
    "ask() succeeds when stdout is agentic-wrapper with valid JSON after 'codex\\n' marker",
    async () => {
      const wrappedStdout = makeAgenticWrapperStdout(
        "You are the samospec Reviewer A...",
        ASK_JSON,
      );

      const spy = makeSpy({
        ok: true,
        exitCode: 0,
        stdout: wrappedStdout,
        stderr: "",
      });
      const adapter = new CodexAdapter({
        host: FAKE_HOST,
        spawn: spy.spawn,
        binary: "/usr/bin/codex",
        models: [{ id: "gpt-5.4", family: "codex" }],
        accountDefaultFallback: false,
      });

      const out = await adapter.ask({
        prompt: "ping",
        context: "",
        opts: OPTS_HIGH,
      });

      expect(out.answer).toBe("agentic-ok");

      // Only one spawn — no repair retry needed.
      expect(spy.calls.length).toBe(1);
    },
  );

  test(
    "critique() succeeds when stdout is agentic-wrapper with valid critique JSON",
    async () => {
      const wrappedStdout = makeAgenticWrapperStdout(
        "You are a paranoid security/ops engineer...",
        CRITIQUE_JSON,
      );

      const spy = makeSpy({
        ok: true,
        exitCode: 0,
        stdout: wrappedStdout,
        stderr: "",
      });
      const adapter = new CodexAdapter({
        host: FAKE_HOST,
        spawn: spy.spawn,
        binary: "/usr/bin/codex",
        models: [{ id: "gpt-5.4", family: "codex" }],
        accountDefaultFallback: false,
      });

      const out = await adapter.critique({
        spec: "# SPEC\n\nHello.",
        guidelines: "Be thorough.",
        opts: OPTS_HIGH,
      } satisfies CritiqueInput);

      expect(out.findings.length).toBe(1);
      expect(out.findings[0]?.category).toBe("missing-risk");
      expect(out.summary).toBe("needs auth");

      expect(spy.calls.length).toBe(1);
    },
  );

  test(
    "agentic-wrapper WITHOUT 'tokens used' footer still extracts JSON until EOF",
    async () => {
      // Some versions may not emit the footer.
      const incompleteWrapper =
        "Reading prompt from stdin...\n" +
        "OpenAI Codex v0.120.0 (research preview)\n" +
        "--------\n" +
        "model: gpt-5.4\n" +
        "--------\n" +
        "user\n" +
        "ping\n" +
        "\n" +
        "codex\n" +
        ASK_JSON +
        "\n";

      const spy = makeSpy({
        ok: true,
        exitCode: 0,
        stdout: incompleteWrapper,
        stderr: "",
      });
      const adapter = new CodexAdapter({
        host: FAKE_HOST,
        spawn: spy.spawn,
        binary: "/usr/bin/codex",
        models: [{ id: "gpt-5.4", family: "codex" }],
        accountDefaultFallback: false,
      });

      const out = await adapter.ask({
        prompt: "ping",
        context: "",
        opts: OPTS_HIGH,
      });
      expect(out.answer).toBe("agentic-ok");
    },
  );

  test(
    "non-wrapped plain JSON still works (backward compatibility)",
    async () => {
      // When codex emits bare JSON (no wrapper), the adapter must still parse it.
      const spy = makeSpy({
        ok: true,
        exitCode: 0,
        stdout: ASK_JSON,
        stderr: "",
      });
      const adapter = new CodexAdapter({
        host: FAKE_HOST,
        spawn: spy.spawn,
        binary: "/usr/bin/codex",
        models: [{ id: "gpt-5.4", family: "codex" }],
        accountDefaultFallback: false,
      });

      const out = await adapter.ask({
        prompt: "ping",
        context: "",
        opts: OPTS_HIGH,
      });
      expect(out.answer).toBe("agentic-ok");
    },
  );

  test(
    "agentic-wrapper with invalid JSON after 'codex\\n' → schema_violation (no silent fail)",
    async () => {
      // A corrupt JSON payload in the codex section must surface as
      // schema_violation (eventually), not silently swallowed.
      const wrappedBadJson =
        "Reading prompt from stdin...\n" +
        "OpenAI Codex v0.120.0 (research preview)\n" +
        "--------\n" +
        "model: gpt-5.4\n" +
        "--------\n" +
        "user\n" +
        "ping\n" +
        "\n" +
        "codex\n" +
        "{ this is not valid json }\n" +
        "\n" +
        "tokens used\n" +
        "100\n";

      const spy = makeSpy({
        ok: true,
        exitCode: 0,
        stdout: wrappedBadJson,
        stderr: "",
      });
      // Two-model list + account-default disabled so repair-retry
      // eventually terminates with schema_violation.
      const adapter = new CodexAdapter({
        host: FAKE_HOST,
        spawn: spy.spawn,
        binary: "/usr/bin/codex",
        models: [{ id: "gpt-5.4", family: "codex" }],
        accountDefaultFallback: false,
      });

      let err: unknown;
      try {
        await adapter.ask({
          prompt: "ping",
          context: "",
          opts: OPTS_HIGH,
        });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(CodexAdapterError);
      if (err instanceof CodexAdapterError) {
        expect(err.payload.reason).toBe("schema_violation");
      }
    },
  );
});

// ---------- contract-style: full agentic-wrapper path ----------

describe("Bug #88-2: full agentic wrapper via fake-CLI fixture (contract path)", () => {
  test(
    "adapter.ask() returns correct answer from agentic-wrapped stdout",
    async () => {
      const fullOutput = makeAgenticWrapperStdout("prompt-text", ASK_JSON);

      let capturedStdin = "";
      const spy: SpawnSpy = {
        calls: [],
        spawn: (input: SpawnCliInput): Promise<SpawnCliResult> => {
          (spy.calls as Array<{ cmd: readonly string[] }>).push({
            cmd: [...input.cmd],
          });
          capturedStdin = input.stdin;
          return Promise.resolve({
            ok: true as const,
            exitCode: 0,
            stdout: fullOutput,
            stderr: "",
          });
        },
      };

      const adapter = new CodexAdapter({
        host: FAKE_HOST,
        spawn: spy.spawn,
        binary: "/usr/bin/codex",
        models: [{ id: "gpt-5.4", family: "codex" }],
        accountDefaultFallback: false,
      });

      const out = await adapter.ask({
        prompt: "test question",
        context: "",
        opts: OPTS_HIGH,
      });

      expect(out.answer).toBe("agentic-ok");
      // Verify the prompt was forwarded to stdin (basic wiring check).
      expect(capturedStdin).toContain("test question");
    },
  );
});
