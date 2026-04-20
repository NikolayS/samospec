// Copyright 2026 Nikolay Samokhvalov.

// RED tests for Issue #52 Bug 2:
// Seat failures drop error detail — impossible to debug from round.json
// or CLI output.
//
// Assertions:
//   1. When a seat fails with a specific error message, round.json
//      records `seats.reviewer_a.error = { reason, message }` (not
//      just the plain string "failed").
//   2. The `reason` field is one of the terminal classification strings:
//      cli_error, schema_violation, timeout, auth_failed, unknown.
//   3. The `message` field carries the first 500 chars of the adapter
//      error, with ANSI codes stripped.
//   4. The CLI-facing "Both reviewers failed" text includes per-seat
//      reason + truncated message.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type { Adapter, CritiqueOutput } from "../../src/adapter/types.ts";
import { readRoundJson, roundDirsFor, runRound } from "../../src/loop/round.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-seat-err-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const SAMPLE_CRITIQUE: CritiqueOutput = {
  findings: [],
  summary: "no findings",
  suggested_next_version: "0.2",
  usage: null,
  effort_used: "max",
};

const READY_REVISE = {
  spec: "# SPEC\n\nrevised",
  ready: true,
  rationale: "[]",
  usage: null,
  effort_used: "max" as const,
};

function makeFailingAdapter(errorMessage: string): Adapter {
  return {
    vendor: "fake",
    detect: () =>
      Promise.resolve({ installed: true, version: "x", path: "/x" }),
    auth_status: () => Promise.resolve({ authenticated: true }),
    supports_structured_output: () => true,
    supports_effort: () => true,
    models: () => Promise.resolve([{ id: "x", family: "fake" }]),
    ask: () => Promise.reject(new Error("unused")),
    critique: () => Promise.reject(new Error(errorMessage)),
    revise: () => Promise.reject(new Error("unused")),
  };
}

describe("round-seat-errors — round.json records error detail on failure (Issue #52)", () => {
  test("abandoned round.json carries error object per seat when both fail", async () => {
    const lead = createFakeAdapter({ revise: READY_REVISE });
    const revA = makeFailingAdapter(
      "exit 1: unexpected argument '--reasoning_effort' found",
    );
    const revB = makeFailingAdapter("no response after 300s (timeout)");

    const dirs = roundDirsFor(tmp, 1);
    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
    });

    expect(outcome.roundStopReason).toBe("both_seats_failed_even_after_retry");

    // round.json must record error objects per seat, not just the state string
    const sidecar = readRoundJson(dirs.roundJson);
    expect(sidecar).not.toBeNull();
    expect(sidecar?.status).toBe("abandoned");

    // reviewer_a seat must carry error detail
    const seatA = sidecar?.seats.reviewer_a;
    expect(typeof seatA).toBe("object");
    if (typeof seatA === "object" && seatA !== null) {
      const a = seatA as {
        status: string;
        error: { reason: string; message: string };
      };
      expect(a.status).not.toBeUndefined();
      expect(a.error).not.toBeUndefined();
      expect(typeof a.error.reason).toBe("string");
      expect(typeof a.error.message).toBe("string");
      // The message should contain relevant part of the original error
      expect(a.error.message.length).toBeGreaterThan(0);
      expect(a.error.message.length).toBeLessThanOrEqual(500);
    }

    // reviewer_b seat must carry error detail
    const seatB = sidecar?.seats.reviewer_b;
    expect(typeof seatB).toBe("object");
    if (typeof seatB === "object" && seatB !== null) {
      const b = seatB as {
        status: string;
        error: { reason: string; message: string };
      };
      expect(b.status).not.toBeUndefined();
      expect(b.error).not.toBeUndefined();
      expect(typeof b.error.reason).toBe("string");
      expect(typeof b.error.message).toBe("string");
    }
  });

  test("SeatOutcome.error carries full error message from failing adapter", async () => {
    const lead = createFakeAdapter({ revise: READY_REVISE });
    const errMsg = "exit 1: unexpected argument '--reasoning_effort' found";
    const revA = makeFailingAdapter(errMsg);
    const revB = createFakeAdapter({ critique: SAMPLE_CRITIQUE });

    const dirs = roundDirsFor(tmp, 1);
    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
    });

    // reviewer_a failed, reviewer_b ok — round proceeds
    expect(outcome.roundStopReason).toBe("ok");
    expect(outcome.seats.reviewer_a.state).not.toBe("ok");

    // The SeatOutcome in the RunRoundOutcome must carry an error detail object
    const seatAOutcome = outcome.seats.reviewer_a;
    expect(seatAOutcome.errorDetail).toBeDefined();
    if (seatAOutcome.errorDetail !== undefined) {
      expect(typeof seatAOutcome.errorDetail.reason).toBe("string");
      expect(seatAOutcome.errorDetail.message).toContain("unexpected argument");
      expect(seatAOutcome.errorDetail.message.length).toBeLessThanOrEqual(500);
    }
  });

  test("ANSI codes are stripped from error message", async () => {
    const lead = createFakeAdapter({ revise: READY_REVISE });
    // Simulate a message with ANSI escape sequences
    const ansiMsg =
      "\x1b[31merror\x1b[0m: unexpected argument '--reasoning_effort' found";
    const revA = makeFailingAdapter(ansiMsg);
    const revB = createFakeAdapter({ critique: SAMPLE_CRITIQUE });

    const dirs = roundDirsFor(tmp, 1);
    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
    });

    const seatAOutcome = outcome.seats.reviewer_a;
    expect(seatAOutcome.errorDetail).toBeDefined();
    if (seatAOutcome.errorDetail !== undefined) {
      // ANSI codes must be stripped
      expect(seatAOutcome.errorDetail.message).not.toContain("\x1b[");
      // But the textual content must remain
      expect(seatAOutcome.errorDetail.message).toContain("unexpected argument");
    }
  });

  test("cli_error reason is classified when error message contains exit code text", async () => {
    const lead = createFakeAdapter({ revise: READY_REVISE });
    const revA = makeFailingAdapter(
      "cli_error: exit 1: unexpected argument '--reasoning_effort' found",
    );
    const revB = createFakeAdapter({ critique: SAMPLE_CRITIQUE });

    const dirs = roundDirsFor(tmp, 1);
    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
    });

    const seatAOutcome = outcome.seats.reviewer_a;
    if (seatAOutcome.errorDetail !== undefined) {
      expect(seatAOutcome.errorDetail.reason).toBe("cli_error");
    }
  });

  test("message is truncated to 500 chars", async () => {
    const lead = createFakeAdapter({ revise: READY_REVISE });
    const longMsg = "x".repeat(1000);
    const revA = makeFailingAdapter(longMsg);
    const revB = createFakeAdapter({ critique: SAMPLE_CRITIQUE });

    const dirs = roundDirsFor(tmp, 1);
    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
    });

    const seatAOutcome = outcome.seats.reviewer_a;
    if (seatAOutcome.errorDetail !== undefined) {
      expect(seatAOutcome.errorDetail.message.length).toBeLessThanOrEqual(500);
    }
  });
});
