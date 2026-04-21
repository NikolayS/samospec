// Copyright 2026 Nikolay Samokhvalov.

// RED test for #81: `samospec new <slug>` with a mock adapter that hangs
// on the first `ask` call must exit within configurable timeout (5s in
// this test) with `lead_terminal` reason and a specific `timeout` message.
//
// The adapter hangs forever on ask(). With the session wall-clock guard
// in place, runNew must kill the hanging phase and return exit 4 with
// a message containing "timeout" and "session-wall-clock".

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
} from "../../src/adapter/types.ts";
import { runNew, type ChoiceResolvers } from "../../src/cli/new.ts";
import { runInit } from "../../src/cli/init.ts";

// Adapter that hangs on ask() indefinitely.
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
    ask: (_input: AskInput): Promise<AskOutput> => {
      // Hangs forever — the session wall-clock guard must preempt this.
      return new Promise(() => {
        /* never resolves */
      });
    },
    critique: (_input: CritiqueInput): Promise<CritiqueOutput> => {
      return new Promise(() => {
        /* never resolves */
      });
    },
    revise: (_input: ReviseInput): Promise<ReviseOutput> => {
      return new Promise(() => {
        /* never resolves */
      });
    },
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
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-hang-"));
  runInit({ cwd: tmp });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("samospec new hang recovery (#81)", () => {
  test("runNew with hanging adapter exits within 10s with exit 4 + session-wall-clock reason", async () => {
    const adapter = makeHangingAdapter();
    const startMs = Date.now();

    // maxWallClockMinutes: use a config-file based cap.
    // The test sets max_session_wall_clock_minutes=0.08 (≈5s) via RunNewInput.
    const result = await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "test idea",
        explain: false,
        resolvers: acceptResolvers(),
        now: "2026-04-19T10:00:00Z",
        // 5-second session wall-clock cap via new field.
        maxSessionWallClockMs: 5_000,
      },
      adapter,
    );
    const elapsedMs = Date.now() - startMs;

    // Must terminate within 10s.
    expect(elapsedMs).toBeLessThan(10_000);

    // Must exit with exit code 4 (lead_terminal).
    expect(result.exitCode).toBe(4);

    // stderr must contain "session-wall-clock" reason (not a generic "adapter error").
    expect(result.stderr.toLowerCase()).toContain("session-wall-clock");
  }, 12_000); // Bun test timeout: 12s
});
