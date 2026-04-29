// Copyright 2026 Nikolay Samokhvalov.

// RED tests for Issue #148: Reviewer A silently dropped on auth failure.
//
// In samo.team production, the codex CLI rejects every call with HTTP
// 401 Unauthorized (service user has no token). samospec captures the
// stderr but the seat-error classifier matches "schema" in the
// prompt-echo BEFORE checking exit/auth, so the failure is stamped
// as `schema_violation` and the round commits with B-only critique.
//
// Three diagnostic bugs hide the real cause:
//
//   A. classifyReviewerError / classifyErrorReason match "schema" in
//      the prompt-echo (the critique prompt itself contains the word
//      "schema") before any other keyword.
//
//   C. sanitizeErrorMessage truncates to the FIRST 500 chars. Codex
//      emits banner + prompt-echo first and the actionable error
//      (e.g. "401 Unauthorized") last, so the prefix slice loses
//      exactly the diagnostic operators need.
//
//   D. Codex stderr classifier `\b5\d{2}\b` over-matches token
//      counts ("tokens used\n2335") and 3-digit substrings of
//      session UUIDs, reclassifying any exit as "timeout".
//
// All four failure modes break the diagnostic chain. This file pins
// the corrected behavior.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type { Adapter, CritiqueOutput } from "../../src/adapter/types.ts";
import { roundDirsFor, runRound } from "../../src/loop/round.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-rev-a-misclass-"));
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

// Production-like error message: codex banner + prompt-echo (which
// includes the literal word "schema" describing the JSON schema) + the
// actual 401 tail at the END.
const PROD_AUTH_FAIL_MESSAGE =
  "Codex adapter other: exit 1: " +
  "Reading prompt from stdin...\n" +
  "OpenAI Codex v0.121.0 (research preview)\n" +
  "--------\n" +
  "workdir: /srv/samo/samospec/38/abc/def\n" +
  "model: gpt-5.4\nprovider: openai\n" +
  "session id: aaaabbbb-cccc-dddd-eeee-ffffffffffff\n" +
  "--------\n" +
  "user\n" +
  "You are a paranoid security/ops engineer reviewing this spec. " +
  "Focus especially on missing-risk, weak-implementation, and " +
  "unnecessary-scope. You may surface findings in other categories " +
  "when warranted, but weight your effort toward these.\n\n" +
  "You are the samospec reviewer. Return ONLY a JSON object matching " +
  'the review-taxonomy schema: { "findings": Array<...> }\n' +
  "(... lots of prompt body that pads past 500 chars ...) " +
  "x".repeat(400) +
  "\n" +
  // The actual error appears at the END.
  "ERROR: unexpected status 401 Unauthorized: Missing bearer or " +
  "basic authentication in header, url: " +
  "https://api.openai.com/v1/responses, request id: req_abc123";

describe("reviewer-a misclassification (#148)", () => {
  test("auth failure is NOT misclassified as schema_violation", async () => {
    // Production failure: codex 401, but stderr-echoed prompt
    // contains the literal word "schema". Expect the seat to be
    // classified as `failed` (or `auth_failed` reason), NOT
    // `schema_violation`.
    const lead = createFakeAdapter({ revise: READY_REVISE });
    const revA = makeFailingAdapter(PROD_AUTH_FAIL_MESSAGE);
    const revB = createFakeAdapter({ critique: SAMPLE_CRITIQUE });

    const dirs = roundDirsFor(tmp, 1);
    const outcome = await runRound({
      now: "2026-04-29T18:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
    });

    const seatA = outcome.seats.reviewer_a;
    // Must NOT be schema_violation — the failure was an exit/auth.
    expect(seatA.state).not.toBe("schema_violation");
  });

  test("auth-failure error reason is classified as auth_failed, not schema_violation", async () => {
    const lead = createFakeAdapter({ revise: READY_REVISE });
    const revA = makeFailingAdapter(PROD_AUTH_FAIL_MESSAGE);
    const revB = createFakeAdapter({ critique: SAMPLE_CRITIQUE });

    const dirs = roundDirsFor(tmp, 1);
    const outcome = await runRound({
      now: "2026-04-29T18:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
    });

    const seatA = outcome.seats.reviewer_a;
    expect(seatA.errorDetail).toBeDefined();
    if (seatA.errorDetail !== undefined) {
      // The structured reason should reflect the actual cause —
      // "auth_failed" (since the tail says "Unauthorized") — not the
      // prompt-echo accident.
      expect(seatA.errorDetail.reason).not.toBe("schema_violation");
    }
  });

  test("error message preserves the diagnostic tail (the 401 line)", async () => {
    const lead = createFakeAdapter({ revise: READY_REVISE });
    const revA = makeFailingAdapter(PROD_AUTH_FAIL_MESSAGE);
    const revB = createFakeAdapter({ critique: SAMPLE_CRITIQUE });

    const dirs = roundDirsFor(tmp, 1);
    const outcome = await runRound({
      now: "2026-04-29T18:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
    });

    const seatA = outcome.seats.reviewer_a;
    expect(seatA.errorDetail).toBeDefined();
    if (seatA.errorDetail !== undefined) {
      // The 500-char window must include the actionable tail (the
      // "Unauthorized" / 401 ERROR line), not just the codex banner /
      // prompt echo. The fix is to keep the tail of stderr, not the
      // prefix.
      expect(seatA.errorDetail.message).toContain("Unauthorized");
      expect(seatA.errorDetail.message.length).toBeLessThanOrEqual(500);
    }
  });

  test("schema-violation messages are still classified as schema_violation", async () => {
    // Sanity: a real schema violation (no prompt-echo, no banner —
    // just the schema-violation detail) must still classify as
    // `schema_violation`. Re-ordering must not lose this.
    const lead = createFakeAdapter({ revise: READY_REVISE });
    const revA = makeFailingAdapter(
      "Codex adapter schema_violation: required field 'findings' missing",
    );
    const revB = createFakeAdapter({ critique: SAMPLE_CRITIQUE });

    const dirs = roundDirsFor(tmp, 1);
    const outcome = await runRound({
      now: "2026-04-29T18:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
    });

    const seatA = outcome.seats.reviewer_a;
    expect(seatA.state).toBe("schema_violation");
    if (seatA.errorDetail !== undefined) {
      expect(seatA.errorDetail.reason).toBe("schema_violation");
    }
  });

  test("timeout messages are still classified as timeout", async () => {
    const lead = createFakeAdapter({ revise: READY_REVISE });
    const revA = makeFailingAdapter(
      "Codex adapter timeout: no response after 300s",
    );
    const revB = createFakeAdapter({ critique: SAMPLE_CRITIQUE });

    const dirs = roundDirsFor(tmp, 1);
    const outcome = await runRound({
      now: "2026-04-29T18:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
    });

    const seatA = outcome.seats.reviewer_a;
    expect(seatA.state).toBe("timeout");
    if (seatA.errorDetail !== undefined) {
      expect(seatA.errorDetail.reason).toBe("timeout");
    }
  });
});
