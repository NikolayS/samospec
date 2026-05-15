// Copyright 2026 Nikolay Samokhvalov.

// Historically (#81) this file asserted that `runNew` killed a hanging
// adapter on the session wall-clock cap, returning exit 4 with a
// `session-wall-clock` reason in stderr. That kill was removed per
// Rule 10 ("nothing kills a dev LLM run on the wall clock") and
// samo.team #415 + #424. The tests below have been rewritten to fence
// the NEW behavior:
//
//   1. With an explicit `maxSessionWallClockMs` set and a hanging
//      adapter, `runNew` does NOT exit 4 + session-wall-clock within
//      a window longer than the cap. The flag is a deprecated no-op.
//   2. Same when the cap is read from `.samo/config.json`
//      `budget.max_session_wall_clock_minutes`.
//   3. A session that would normally complete still completes (the
//      removal didn't break the happy path).
//
// The primary behavior fence lives in
// `tests/cli/no-wall-clock-kill.test.ts`; this file preserves the
// historical entry points so that anyone landing here from #81 / git
// blame sees why the assertion shape inverted.

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

/** Race a promise against a real-time deadline. */
async function raceDeadline<T>(
  p: Promise<T>,
  deadlineMs: number,
): Promise<{ resolved: true; value: T } | { resolved: false }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ resolved: false });
    }, deadlineMs);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve({ resolved: true, value });
      },
      () => {
        clearTimeout(timer);
        resolve({ resolved: false });
      },
    );
  });
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-wallclock-"));
  runInit({ cwd: tmp });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("session wall-clock cap is a deprecated no-op (#81 / samo.team #415, #424)", () => {
  test("hanging adapter is NOT preempted by maxSessionWallClockMs", async () => {
    const adapter = makeHangingAdapter();
    const capMs = 2_000;

    const runPromise = runNew(
      {
        cwd: tmp,
        slug: "wc-test",
        idea: "wall clock test",
        explain: false,
        resolvers: acceptResolvers(),
        now: "2026-04-19T10:00:00Z",
        maxSessionWallClockMs: capMs,
      },
      adapter,
    );

    // The CLI must still be running past the (now-ignored) cap.
    const outcome = await raceDeadline(runPromise, capMs * 2 + 500);
    expect(outcome.resolved).toBe(false);
  }, 10_000);

  test("hanging adapter is NOT preempted by config.json budget.max_session_wall_clock_minutes", async () => {
    // Patch the config to set max_session_wall_clock_minutes = 0.05 (3s).
    const configPath = path.join(tmp, ".samo", "config.json");
    const raw = readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const budget = (cfg["budget"] ?? {}) as Record<string, unknown>;
    budget["max_session_wall_clock_minutes"] = 0.05; // ~3s
    cfg["budget"] = budget;
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const adapter = makeHangingAdapter();

    const runPromise = runNew(
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

    // Configured cap is ~3s; the CLI must still be running past 6s.
    const outcome = await raceDeadline(runPromise, 6_000);
    expect(outcome.resolved).toBe(false);
  }, 10_000);

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
        // Generous cap value — ignored, but legal input.
        maxSessionWallClockMs: 600_000,
      },
      fastAdapter,
    );

    expect(result.exitCode).toBe(0);
  }, 30_000);
});
