// Copyright 2026 Nikolay Samokhvalov.

// RED tests for Issue #52 Bug 1:
// Codex CLI 0.120.0 does not accept --reasoning_effort; the correct form
// is `-c model_reasoning_effort=<level>`.
//
// These assertions lock down:
//   - The `-c model_reasoning_effort=<level>` arg pair is present in argv.
//   - The `--reasoning_effort` flag is NOT present in argv.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAdapter } from "../../src/adapter/codex.ts";
import type { AskInput, EffortLevel } from "../../src/adapter/types.ts";
import type { SpawnCliInput, SpawnCliResult } from "../../src/adapter/spawn.ts";

const TMP: string[] = [];

function makeFakeBinaryDir(): { dir: string; binary: string } {
  const dir = mkdtempSync(join(tmpdir(), "samospec-codex-spawn-flags-"));
  TMP.push(dir);
  const binary = join(dir, "codex");
  writeFileSync(binary, "#!/usr/bin/env bash\necho 0.120.0\n");
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

const FAKE_API_HOST = { OPENAI_API_KEY: "sk-openai-test-fake-key" };

interface SpyCall {
  readonly cmd: readonly string[];
}

function makespy(): {
  spawn: (input: SpawnCliInput) => Promise<SpawnCliResult>;
  calls: SpyCall[];
} {
  const calls: SpyCall[] = [];
  const happy: SpawnCliResult = {
    ok: true,
    exitCode: 0,
    stdout: '{"answer":"ok","usage":null,"effort_used":"high"}',
    stderr: "",
  };
  const spawn = (input: SpawnCliInput): Promise<SpawnCliResult> => {
    calls.push({ cmd: [...input.cmd] });
    return Promise.resolve(happy);
  };
  return { spawn, calls };
}

function sampleAsk(level: EffortLevel): AskInput {
  return {
    prompt: "ping",
    context: "",
    opts: { effort: level, timeout: 120_000 },
  };
}

describe("codex spawn flags — -c model_reasoning_effort=<level> (Issue #52)", () => {
  const cases: readonly [EffortLevel, string][] = [
    ["max", "high"],
    ["high", "high"],
    ["medium", "medium"],
    ["low", "low"],
    ["off", "minimal"],
  ];

  for (const [level, expected] of cases) {
    test(`logical '${level}' -> -c model_reasoning_effort=${expected}`, async () => {
      const spy = makespy();
      const { dir } = makeFakeBinaryDir();
      const adapter = new CodexAdapter({
        host: { PATH: dir, HOME: "/tmp", ...FAKE_API_HOST },
        spawn: spy.spawn,
      });

      await adapter.ask(sampleAsk(level));

      const work = spy.calls[0];
      expect(work).toBeDefined();
      if (work === undefined) return;

      // MUST have `-c` followed by `model_reasoning_effort=<expected>`
      const idx = work.cmd.findIndex((c) => c === "-c");
      expect(idx).toBeGreaterThan(-1);
      expect(work.cmd[idx + 1]).toBe(`model_reasoning_effort=${expected}`);

      // MUST NOT have the old invalid flag `--reasoning_effort`
      expect(work.cmd).not.toContain("--reasoning_effort");
    });
  }
});
