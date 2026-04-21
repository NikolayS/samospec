// Copyright 2026 Nikolay Samokhvalov.

// RED test for Issue #88 reviewer follow-up: agentic-wrapper parser
// false-positive.
//
// If a USER prompt echoed in the banner contains a standalone "codex"
// line, the extractor picks the wrong slice. The `codex\n` marker is
// only meaningful AFTER the "user\n<prompt>" block terminates. We must
// skip past the first user-echo block before searching for the
// response marker.

import { describe, expect, test } from "bun:test";

import { CodexAdapter, CodexAdapterError } from "../../src/adapter/codex.ts";
import type { EffortLevel } from "../../src/adapter/types.ts";
import type { SpawnCliInput, SpawnCliResult } from "../../src/adapter/spawn.ts";

interface SpawnSpy {
  readonly spawn: (input: SpawnCliInput) => Promise<SpawnCliResult>;
  readonly calls: { cmd: readonly string[] }[];
}

function makeSpy(response: SpawnCliResult): SpawnSpy {
  const calls: { cmd: readonly string[] }[] = [];
  const spawn = (input: SpawnCliInput): Promise<SpawnCliResult> => {
    calls.push({ cmd: [...input.cmd] });
    return Promise.resolve(response);
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

const ASK_JSON = '{"answer":"real-response","usage":null,"effort_used":"high"}';

describe("Bug #88-followup: agentic-wrapper false-positive on rogue 'codex' in user prompt", () => {
  test("user prompt containing a standalone 'codex' line → extractor must still pick the real response", async () => {
    // The user prompt echoes back with its OWN `codex\n` line. The
    // extractor (naive "first `codex` marker" search) would stop on
    // that line and return the remainder of the prompt echo, which
    // does not contain valid JSON and would fail parsing.
    //
    // Fix: only treat `codex\n` as the response marker AFTER the
    // user-echo block — i.e. after a `--------` separator has been
    // consumed following the `user\n` section, OR skip the first
    // occurrence that appears inside the user block.
    const wrappedWithRogueCodex =
      "OpenAI Codex v0.120.0 (research preview)\n" +
      "--------\n" +
      "workdir: /private/tmp/test\n" +
      "model: gpt-5.4\n" +
      "provider: openai\n" +
      "--------\n" +
      "user\n" +
      "Please analyze this spec. The word\n" +
      "codex\n" +
      "appears in the middle of my prompt and should NOT be mistaken\n" +
      "for the response marker. Return JSON with your findings.\n" +
      "\n" +
      "codex\n" +
      ASK_JSON +
      "\n" +
      "\n" +
      "tokens used\n" +
      "2561\n";

    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout: wrappedWithRogueCodex,
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
      prompt: "rogue",
      context: "",
      opts: OPTS_HIGH,
    });

    // Must succeed — must NOT misparse the rogue `codex` line.
    expect(out.answer).toBe("real-response");
    expect(spy.calls.length).toBe(1);
  });

  test("user prompt with rogue 'codex' BUT no subsequent real response → schema_violation (not silent misparse)", async () => {
    // Defensive: even if the codex CLI is truncated and only the user
    // echo is present, we should get schema_violation — not a silent
    // parse of the prompt echo as if it were the response.
    const truncatedWrapper =
      "OpenAI Codex v0.120.0 (research preview)\n" +
      "--------\n" +
      "model: gpt-5.4\n" +
      "--------\n" +
      "user\n" +
      "codex\n" +
      "Not valid JSON here either\n";

    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout: truncatedWrapper,
      stderr: "",
    });
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
        prompt: "truncated",
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
  });
});
