// Copyright 2026 Nikolay Samokhvalov.

// Effort mapping + fallback chain ordering tests (SPEC §11).
// These assertions complement the contract suite: they lock down the
// exact reasoning_effort value emitted per logical EffortLevel and the
// order in which the adapter walks the pinned fallback chain.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAdapter } from "../../src/adapter/codex.ts";
import {
  type AskInput,
  type EffortLevel,
  type ModelInfo,
} from "../../src/adapter/types.ts";
import {
  type SpawnCliInput,
  type SpawnCliResult,
} from "../../src/adapter/spawn.ts";

const TMP: string[] = [];

function makeFakeBinaryDir(): { dir: string; binary: string } {
  const dir = mkdtempSync(join(tmpdir(), "samospec-codex-effort-"));
  TMP.push(dir);
  const binary = join(dir, "codex");
  writeFileSync(binary, "#!/usr/bin/env bash\necho 0.41.0\n");
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

interface SpyCall {
  readonly cmd: readonly string[];
}
interface Spy {
  readonly spawn: (input: SpawnCliInput) => Promise<SpawnCliResult>;
  readonly calls: SpyCall[];
}

function scriptedSpy(responses: readonly SpawnCliResult[]): Spy {
  const calls: SpyCall[] = [];
  const spawn = (input: SpawnCliInput): Promise<SpawnCliResult> => {
    calls.push({ cmd: [...input.cmd] });
    const r = responses[calls.length - 1] ?? responses[responses.length - 1]!;
    return Promise.resolve(r);
  };
  return { spawn, calls };
}

const HAPPY: SpawnCliResult = {
  ok: true,
  exitCode: 0,
  stdout: '{"answer":"ok","usage":null,"effort_used":"high"}',
  stderr: "",
};

function sampleAskWithEffort(level: EffortLevel): AskInput {
  return {
    prompt: "ping",
    context: "",
    opts: { effort: level, timeout: 120_000 },
  };
}

describe("CodexAdapter effort-level mapping (SPEC §11 table)", () => {
  const cases: ReadonlyArray<[EffortLevel, string]> = [
    ["max", "high"],
    ["high", "high"],
    ["medium", "medium"],
    ["low", "low"],
    ["off", "minimal"],
  ];

  for (const [level, expected] of cases) {
    test(`logical '${level}' -> reasoning_effort '${expected}'`, async () => {
      const spy = scriptedSpy([HAPPY]);
      const { dir } = makeFakeBinaryDir();
      const adapter = new CodexAdapter({
        host: { PATH: dir, HOME: "/tmp" },
        spawn: spy.spawn,
      });
      await adapter.ask(sampleAskWithEffort(level));

      // The work-call includes the model id plus the reasoning-effort
      // value, positional-paired after `--reasoning_effort`.
      const work = spy.calls[0];
      expect(work).toBeDefined();
      if (work === undefined) return;
      const idx = work.cmd.findIndex((c) => c === "--reasoning_effort");
      expect(idx).toBeGreaterThan(-1);
      expect(work.cmd[idx + 1]).toBe(expected);
    });
  }
});

describe("CodexAdapter fallback-chain ordering (SPEC §11)", () => {
  test("default chain is gpt-5.1-codex-max first, gpt-5.1-codex second", async () => {
    // Rejecting every attempt with model-not-available forces the
    // adapter to walk the chain; the spawn cmds capture the order.
    const reject: SpawnCliResult = {
      ok: true,
      exitCode: 2,
      stdout: "",
      stderr: "error: model is not available for this account\n",
    };
    const spy = scriptedSpy([reject, reject]);
    const { dir } = makeFakeBinaryDir();
    const adapter = new CodexAdapter({
      host: { PATH: dir, HOME: "/tmp" },
      spawn: spy.spawn,
    });

    await adapter.ask(sampleAskWithEffort("high")).catch(() => {
      /* expected terminal */
    });

    expect(spy.calls.length).toBe(2);
    const first = spy.calls[0]?.cmd ?? [];
    const second = spy.calls[1]?.cmd ?? [];
    expect(first).toContain("gpt-5.1-codex-max");
    expect(second).toContain("gpt-5.1-codex");
    expect(second).not.toContain("gpt-5.1-codex-max");
  });

  test("custom model list is respected in order, default still leads", async () => {
    const reject: SpawnCliResult = {
      ok: true,
      exitCode: 2,
      stdout: "",
      stderr: "error: model is not available for this account\n",
    };
    const custom: readonly ModelInfo[] = [
      { id: "custom-a", family: "codex" },
      { id: "custom-b", family: "codex" },
    ];
    const spy = scriptedSpy([reject, reject, reject]);
    const { dir } = makeFakeBinaryDir();
    const adapter = new CodexAdapter({
      host: { PATH: dir, HOME: "/tmp" },
      spawn: spy.spawn,
      models: custom,
      defaultModel: "custom-a",
    });

    await adapter.ask(sampleAskWithEffort("high")).catch(() => {
      /* expected terminal */
    });

    expect(spy.calls.length).toBe(2);
    expect(spy.calls[0]?.cmd).toContain("custom-a");
    expect(spy.calls[1]?.cmd).toContain("custom-b");
  });
});
