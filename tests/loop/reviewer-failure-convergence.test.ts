// Copyright 2026 Nikolay Samokhvalov.

// RED tests for Issue #64: reviewer failures silently allow premature
// convergence. When both reviewers fail, the lead must NOT be allowed to
// declare ready=true — the round should be marked as a failure and the
// ready signal ignored.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type {
  Adapter,
  CritiqueOutput,
  ReviseOutput,
} from "../../src/adapter/types.ts";
import { roundDirsFor, runRound } from "../../src/loop/round.ts";
import { classifyAllStops } from "../../src/loop/stopping.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-conv64-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------- fixtures ----------

const SAMPLE_CRITIQUE: CritiqueOutput = {
  findings: [
    { category: "ambiguity", text: "vague clause", severity: "minor" },
  ],
  summary: "one finding",
  suggested_next_version: "0.2",
  usage: null,
  effort_used: "max",
};

const READY_TRUE_REVISE: ReviseOutput = {
  spec: "# SPEC\n\nready output",
  ready: true,
  rationale: "all good",
  usage: null,
  effort_used: "max",
};

const NOT_READY_REVISE: ReviseOutput = {
  spec: "# SPEC\n\nstill working",
  ready: false,
  rationale: "more work needed",
  usage: null,
  effort_used: "max",
};

/** Create an adapter whose critique() always rejects with the given error. */
function makeFailingReviewer(msg: string): Adapter {
  const base = createFakeAdapter();
  return {
    ...base,
    critique: () => Promise.reject(new Error(msg)),
  };
}

// ---------- tests: both reviewers fail ----------

describe("#64 — both reviewers fail: ready=true MUST be ignored", () => {
  test(
    "when both reviewers fail and lead would return ready=true, " +
      "outcome.ready is false and roundStopReason is not 'ok'",
    async () => {
      // The lead would declare ready=true if called with valid reviews,
      // but with no valid reviewer output this round, it must be blocked.
      const lead = createFakeAdapter({ revise: READY_TRUE_REVISE });
      const revA = makeFailingReviewer("Codex adapter timeout");
      const revB = makeFailingReviewer('unknown — [{ "code": "invalid_value"');

      const dirs = roundDirsFor(tmp, 1);
      const outcome = await runRound({
        now: "2026-04-19T12:00:00Z",
        roundNumber: 1,
        dirs,
        specText: "# SPEC\n\nv0.1",
        decisionsHistory: [],
        adapters: { lead, reviewerA: revA, reviewerB: revB },
      });

      // The bug: before the fix, outcome.ready would be true.
      // After the fix: round must NOT converge on an all-reviewer-fail.
      expect(outcome.ready).toBe(false);
      // The round stop reason must reflect failure, not success.
      expect(outcome.roundStopReason).not.toBe("ok");
    },
  );

  test("when both reviewers fail, reviewersExhausted is true", async () => {
    const lead = createFakeAdapter({ revise: READY_TRUE_REVISE });
    const revA = makeFailingReviewer("timeout: codex timed out");
    const revB = makeFailingReviewer("auth failed");

    const dirs = roundDirsFor(tmp, 1);
    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC\n\nv0.1",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
    });

    expect(outcome.reviewersExhausted).toBe(true);
    expect(outcome.seats.reviewer_a.state).not.toBe("ok");
    expect(outcome.seats.reviewer_b.state).not.toBe("ok");
  });
});

// ---------- tests: partial failure (one reviewer ok) ----------

describe("#64 — partial reviewer failure: ready=true IS accepted", () => {
  test(
    "when reviewer_a fails but reviewer_b succeeds, " +
      "lead's ready=true is accepted",
    async () => {
      const lead = createFakeAdapter({ revise: READY_TRUE_REVISE });
      const revA = makeFailingReviewer("Codex adapter timeout");
      const revB = createFakeAdapter({ critique: SAMPLE_CRITIQUE });

      const dirs = roundDirsFor(tmp, 1);
      const outcome = await runRound({
        now: "2026-04-19T12:00:00Z",
        roundNumber: 1,
        dirs,
        specText: "# SPEC\n\nv0.1",
        decisionsHistory: [],
        adapters: { lead, reviewerA: revA, reviewerB: revB },
      });

      // Partial review is valid: ready=true should be accepted.
      expect(outcome.ready).toBe(true);
      expect(outcome.roundStopReason).toBe("ok");
    },
  );

  test(
    "when reviewer_b fails but reviewer_a succeeds, " +
      "lead's ready=true is accepted",
    async () => {
      const lead = createFakeAdapter({ revise: READY_TRUE_REVISE });
      const revA = createFakeAdapter({ critique: SAMPLE_CRITIQUE });
      const revB = makeFailingReviewer("claude auth_failed");

      const dirs = roundDirsFor(tmp, 1);
      const outcome = await runRound({
        now: "2026-04-19T12:00:00Z",
        roundNumber: 1,
        dirs,
        specText: "# SPEC\n\nv0.1",
        decisionsHistory: [],
        adapters: { lead, reviewerA: revA, reviewerB: revB },
      });

      expect(outcome.ready).toBe(true);
      expect(outcome.roundStopReason).toBe("ok");
    },
  );
});

// ---------- tests: all-reviewer-fail stopping condition ----------

describe(
  "#64 — all-reviewer-fail stopping condition " +
    "(classifyAllStops with reviewerAvailability=0)",
  () => {
    const baseSignals = {
      findings: [],
      diffLines: 5,
      nonSummaryCategoriesWithFindings: 0,
    };

    test(
      "classifyAllStops with reviewerAvailability=0 stops with " +
        "'reviewers-exhausted', NOT 'ready' or 'semantic-convergence'",
      () => {
        const result = classifyAllStops({
          currentRoundIndex: 2,
          maxRounds: 10,
          // Lead would declare ready=true, but reviewers are exhausted.
          leadReady: true,
          previous: baseSignals,
          current: baseSignals,
          reviewerAvailability: 0,
          budgetOk: true,
          wallClockOk: true,
          leadTerminal: false,
          sigintReceived: false,
        });

        // Bug: before fix, "ready" would fire at condition #2 before
        // reviewerAvailability check at condition #6. After fix, when
        // all reviewers failed, "ready" should NOT be a valid stop cause.
        expect(result.stop).toBe(true);
        expect(result.reason).not.toBe("ready");
        expect(result.reason).not.toBe("semantic-convergence");
        // Should stop for the reviewer-exhausted reason instead.
        expect(result.reason).toBe("reviewers-exhausted");
      },
    );

    test(
      "when all reviewers fail across max rounds (max-rounds stop), " +
        "the stop reason is 'max-rounds', not 'ready'",
      () => {
        const result = classifyAllStops({
          currentRoundIndex: 10,
          maxRounds: 10,
          leadReady: true,
          previous: baseSignals,
          current: baseSignals,
          reviewerAvailability: 0,
          budgetOk: true,
          wallClockOk: true,
          leadTerminal: false,
          sigintReceived: false,
        });

        expect(result.stop).toBe(true);
        // max-rounds fires first (condition #1) — that's fine.
        // The key is that the stop reason is not 'ready'.
        expect(result.reason).not.toBe("ready");
      },
    );

    test(
      "runRound with both reviewers failing across retry returns " +
        "roundStopReason='both_seats_failed_even_after_retry'",
      async () => {
        const lead = createFakeAdapter({ revise: NOT_READY_REVISE });
        const revA = makeFailingReviewer("timeout every time");
        const revB = makeFailingReviewer("timeout every time");

        const dirs = roundDirsFor(tmp, 2);
        const outcome = await runRound({
          now: "2026-04-19T12:00:00Z",
          roundNumber: 2,
          dirs,
          specText: "# SPEC\n\nv0.2",
          decisionsHistory: [],
          adapters: { lead, reviewerA: revA, reviewerB: revB },
        });

        expect(outcome.roundStopReason).toBe(
          "both_seats_failed_even_after_retry",
        );
        expect(outcome.ready).toBe(false);
      },
    );
  },
);
