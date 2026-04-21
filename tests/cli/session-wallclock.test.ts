// Copyright 2026 Nikolay Samokhvalov.

// RED test for #81: session wall-clock cap.
//
// SPEC §7 default: 10 minutes session wall-clock cap, configurable via
// `.samo/config.json` `budget.max_session_wall_clock_minutes`.
//
// Tests:
// 1. A session that exceeds the wall-clock cap terminates with reason
//    `session-wall-clock` and exit code 4.
// 2. The cap is read from config.json `budget.max_session_wall_clock_minutes`
//    when present.
// 3. A session that completes within the cap succeeds normally.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  Adapter,
  AskInput,
  AskOutput,
  AuthStatus,
  CritiqueInput,
  CritiqueOutput,
  DetectResult,
  EffortLevel,
  ModelInfo,
  ReviseInput,
  ReviseOutput,
} from "../../src/adapter/types.ts";
import { runNew, type ChoiceResolvers } from "../../src/cli/new.ts";
import { runInit } from "../../src/cli/init.ts";

function makeHangingAdapter(): Adapter {
  const auth: AuthStatus = { authenticated: true, subscription_auth: false };
  return {
    vendor: "fake-hang",
    detect: (): Promise<DetectResult> =>
      Promise.resolve({ installed: true, version: "0", path: "/fake" }),
    auth_status: (): Promise<AuthStatus> => Promise.resolve(auth),
    supports_structured_output: () => true,
    supports_effort: (_level: EffortLevel) => true,
    models: (): Promise<readonly ModelInfo[]> =>
      Promise.resolve([{ id: "fake", family: "fake" }]),
    ask: (_input: AskInput): Promise<AskOutput> =>
      new Promise(() => {
        /* hangs */
      }),
    critique: (_input: CritiqueInput): Promise<CritiqueOutput> =>
      new Promise(() => {
        /* hangs */
      }),
    revise: (_input: ReviseInput): Promise<ReviseOutput> =>
      new Promise(() => {
        /* hangs */
      }),
  };
}

function acceptResolvers(): ChoiceResolvers {
  return {
    persona: () => Promise.resolve({ kind: "accept" }),
    question: (_q) => Promise.resolve({ choice: "decide for me" }),
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-wallclock-"));
  runInit({ cwd: tmp });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("session wall-clock cap (#81)", () => {
  test("exceeding wall-clock cap terminates with exit 4 + session-wall-clock reason", async () => {
    const adapter = makeHangingAdapter();
    const startMs = Date.now();

    const result = await runNew(
      {
        cwd: tmp,
        slug: "wc-test",
        idea: "wall clock test",
        explain: false,
        resolvers: acceptResolvers(),
        now: "2026-04-19T10:00:00Z",
        // 3-second session wall-clock cap.
        maxSessionWallClockMs: 3_000,
      },
      adapter,
    );
    const elapsedMs = Date.now() - startMs;

    expect(elapsedMs).toBeLessThan(8_000);
    expect(result.exitCode).toBe(4);
    expect(result.stderr.toLowerCase()).toContain("session-wall-clock");
  }, 10_000);

  test("wall-clock cap is read from config.json budget.max_session_wall_clock_minutes", async () => {
    // Patch the config to set max_session_wall_clock_minutes = 0.05 (3s).
    const configPath = path.join(tmp, ".samo", "config.json");
    const raw = readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const budget = (cfg["budget"] ?? {}) as Record<string, unknown>;
    budget["max_session_wall_clock_minutes"] = 0.05; // ~3s
    cfg["budget"] = budget;
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const adapter = makeHangingAdapter();
    const startMs = Date.now();

    // Do NOT pass maxSessionWallClockMs — must read from config.
    const result = await runNew(
      {
        cwd: tmp,
        slug: "cfg-wc",
        idea: "config wall clock test",
        explain: false,
        resolvers: acceptResolvers(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    const elapsedMs = Date.now() - startMs;

    expect(elapsedMs).toBeLessThan(10_000);
    expect(result.exitCode).toBe(4);
    expect(result.stderr.toLowerCase()).toContain("session-wall-clock");
  }, 12_000);

  test("session that completes within wall-clock cap exits 0", async () => {
    // Fast-responding adapter that completes immediately.
    const personaJson = JSON.stringify({
      persona: 'Veteran "CLI engineer" expert',
      rationale: "fast",
    });
    const questionsJson = JSON.stringify({
      questions: [{ id: "q1", text: "scope?", options: ["narrow", "wide"] }],
    });
    let callCount = 0;
    const fastAdapter: Adapter = {
      vendor: "fake-fast",
      detect: (): Promise<DetectResult> =>
        Promise.resolve({ installed: true, version: "0", path: "/fake" }),
      auth_status: (): Promise<AuthStatus> =>
        Promise.resolve({ authenticated: true, subscription_auth: false }),
      supports_structured_output: () => true,
      supports_effort: (_level: EffortLevel) => true,
      models: (): Promise<readonly ModelInfo[]> =>
        Promise.resolve([{ id: "fake", family: "fake" }]),
      ask: (_input: AskInput): Promise<AskOutput> => {
        const c = callCount++;
        const answer = c === 0 ? personaJson : questionsJson;
        return Promise.resolve({ answer, usage: null, effort_used: "max" });
      },
      critique: (_input: CritiqueInput): Promise<CritiqueOutput> =>
        Promise.resolve({
          findings: [],
          summary: "ok",
          suggested_next_version: "0.1.1",
          usage: null,
          effort_used: "max",
        }),
      revise: (_input: ReviseInput): Promise<ReviseOutput> =>
        Promise.resolve({
          spec: "# SPEC\n\nok.",
          ready: true,
          rationale: "done",
          decisions: [],
          usage: null,
          effort_used: "max",
        }),
    };

    const result = await runNew(
      {
        cwd: tmp,
        slug: "fast-run",
        idea: "fast test",
        explain: false,
        resolvers: acceptResolvers(),
        now: "2026-04-19T10:00:00Z",
        // 10-minute cap — should be more than enough.
        maxSessionWallClockMs: 600_000,
      },
      fastAdapter,
    );

    expect(result.exitCode).toBe(0);
  }, 30_000);
});
