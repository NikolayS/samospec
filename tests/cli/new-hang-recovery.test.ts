// Copyright 2026 Nikolay Samokhvalov.

// Historically (#81) this test asserted that `samospec new <slug>` with
// a hanging adapter exited within ~5s with `lead_terminal` exit 4 and a
// `session-wall-clock` reason. That kill was removed per Rule 10 and
// samo.team #415 + #424. The test below now fences the NEW behavior:
// the CLI must NOT exit on a wall-clock timer; the run keeps going
// until the parent sends SIGTERM or the inactivity heartbeat decides
// to surface a warning (non-killing).
//
// See `tests/cli/no-wall-clock-kill.test.ts` for the primary behavior
// fence.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
  StructuredAskInput,
  StructuredAskOutput,
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
        /* never resolves */
      }),
    structuredAsk: (
      _input: StructuredAskInput,
    ): Promise<StructuredAskOutput> =>
      new Promise(() => {
        /* never resolves */
      }),
    critique: (_input: CritiqueInput): Promise<CritiqueOutput> =>
      new Promise(() => {
        /* never resolves */
      }),
    revise: (_input: ReviseInput): Promise<ReviseOutput> =>
      new Promise(() => {
        /* never resolves */
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
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-hang-"));
  runInit({ cwd: tmp });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("samospec new hang behavior (#81 / samo.team #415, #424)", () => {
  test("runNew with hanging adapter does NOT exit on the wall clock", async () => {
    const adapter = makeHangingAdapter();
    const capMs = 1_500;

    const runPromise = runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "test idea",
        explain: false,
        resolvers: acceptResolvers(),
        now: "2026-04-19T10:00:00Z",
        // Old kill would have triggered exit 4 within capMs.
        maxSessionWallClockMs: capMs,
      },
      adapter,
    );

    // Run must still be in-flight past 3x the cap.
    const outcome = await raceDeadline(runPromise, capMs * 3);
    expect(outcome.resolved).toBe(false);
  }, 8_000);
});
