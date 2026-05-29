// Copyright 2026 Nikolay Samokhvalov.

// RED tests for resumable reviews (samospec robustness pass).
//
// When a round reached `lead_terminal` because the lead's revise() timed
// out, the reviewer critiques are already persisted on disk (codex.md /
// claude.md carry the `<!-- samospec:critique v1 -->` JSON trailer).
// Re-running the round must RETRY the lead revise REUSING those saved
// critiques WITHOUT re-invoking the reviewers.
//
// Assertions:
//   1. `loadPersistedCritiques(dirs)` recovers both seat critiques.
//   2. runRound with `reusedCritiques` does NOT call reviewer adapters.
//   3. A lead that times out once then succeeds yields a v0.2 revise.
//   4. round.json is marked complete and the saved critiques flow to the
//      lead's revise() reviews argument.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type {
  Adapter,
  CritiqueInput,
  CritiqueOutput,
  ReviseInput,
  ReviseOutput,
} from "../../src/adapter/types.ts";
import {
  loadPersistedCritiques,
  readRoundJson,
  renderCritiqueMarkdown,
  roundDirsFor,
  runRound,
} from "../../src/loop/round.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-resume-crit-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const CRIT_A: CritiqueOutput = {
  findings: [
    { category: "missing-risk", text: "no auth story", severity: "major" },
  ],
  summary: "reviewer A summary",
  suggested_next_version: "0.2",
  usage: null,
  effort_used: "max",
};

const CRIT_B: CritiqueOutput = {
  findings: [
    { category: "weak-implementation", text: "no tests", severity: "minor" },
  ],
  summary: "reviewer B summary",
  suggested_next_version: "0.2",
  usage: null,
  effort_used: "max",
};

const READY_REVISE: ReviseOutput = {
  spec: "# SPEC v0.2\n\nrevised after reusing saved critiques",
  ready: true,
  rationale: "[]",
  decisions: [],
  usage: null,
  effort_used: "max",
};

/** Reviewer adapter that EXPLODES if its critique() is ever called. */
function explodingReviewer(): Adapter {
  return {
    vendor: "fake",
    detect: () =>
      Promise.resolve({ installed: true, version: "x", path: "/x" }),
    auth_status: () => Promise.resolve({ authenticated: true }),
    supports_structured_output: () => true,
    supports_effort: () => true,
    models: () => Promise.resolve([{ id: "x", family: "fake" }]),
    ask: () => Promise.reject(new Error("unused")),
    critique: (_input: CritiqueInput) =>
      Promise.reject(new Error("reviewer must NOT be invoked on resume")),
    revise: () => Promise.reject(new Error("unused")),
  };
}

/** Lead that times out on the first revise() then succeeds. */
function flakyLead(): { adapter: Adapter; reviseCalls: () => number } {
  let calls = 0;
  let capturedReviews: readonly CritiqueOutput[] = [];
  const adapter: Adapter = {
    vendor: "fake-lead",
    detect: () =>
      Promise.resolve({ installed: true, version: "x", path: "/x" }),
    auth_status: () => Promise.resolve({ authenticated: true }),
    supports_structured_output: () => true,
    supports_effort: () => true,
    models: () => Promise.resolve([{ id: "x", family: "fake" }]),
    ask: () => Promise.reject(new Error("unused")),
    critique: () => Promise.reject(new Error("unused")),
    revise: (input: ReviseInput): Promise<ReviseOutput> => {
      calls += 1;
      capturedReviews = input.reviews;
      if (calls === 1) {
        // Hang past the per-call deadline so the orchestrator preempts.
        return new Promise<ReviseOutput>(() => {
          /* never resolves */
        });
      }
      // Second attempt: confirm the saved critiques reached the lead.
      expect(capturedReviews.length).toBe(2);
      return Promise.resolve(READY_REVISE);
    },
  };
  return { adapter, reviseCalls: () => calls };
}

function seedPersistedCritiques(dir: ReturnType<typeof roundDirsFor>): void {
  mkdirSync(dir.roundDir, { recursive: true });
  writeFileSync(
    dir.codexPath,
    renderCritiqueMarkdown(CRIT_A, "reviewer_a"),
    "utf8",
  );
  writeFileSync(
    dir.claudePath,
    renderCritiqueMarkdown(CRIT_B, "reviewer_b"),
    "utf8",
  );
}

describe("resumable reviews — reuse persisted critiques without re-running reviewers", () => {
  test("loadPersistedCritiques recovers both seat critiques", () => {
    const dirs = roundDirsFor(tmp, 1);
    seedPersistedCritiques(dirs);
    const loaded = loadPersistedCritiques(dirs);
    expect(loaded).not.toBeNull();
    expect(loaded?.reviewer_a?.summary).toBe("reviewer A summary");
    expect(loaded?.reviewer_b?.summary).toBe("reviewer B summary");
  });

  test("loadPersistedCritiques returns null when files are missing", () => {
    const dirs = roundDirsFor(tmp, 2);
    expect(loadPersistedCritiques(dirs)).toBeNull();
  });

  test("runRound with reusedCritiques does not invoke reviewers and produces v0.2", async () => {
    const dirs = roundDirsFor(tmp, 1);
    seedPersistedCritiques(dirs);
    const reused = loadPersistedCritiques(dirs);
    expect(reused).not.toBeNull();
    if (reused === null) return;

    const { adapter: lead, reviseCalls } = flakyLead();
    const revA = explodingReviewer();
    const revB = explodingReviewer();

    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC v0.1\n\noriginal",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
      // Short revise timeout so the first (hanging) attempt is preempted
      // fast, then the whole-round retry path re-revises and succeeds.
      reviseTimeoutMs: 50,
      reusedCritiques: {
        ...(reused.reviewer_a !== null
          ? { reviewer_a: reused.reviewer_a }
          : {}),
        ...(reused.reviewer_b !== null
          ? { reviewer_b: reused.reviewer_b }
          : {}),
      },
    });

    expect(outcome.roundStopReason).toBe("ok");
    expect(outcome.revisedSpec).toBe(READY_REVISE.spec);
    expect(outcome.ready).toBe(true);
    // Lead revise() retried once (timeout) then succeeded.
    expect(reviseCalls()).toBeGreaterThanOrEqual(2);

    // round.json complete with both seats ok.
    const sidecar = readRoundJson(dirs.roundJson);
    expect(sidecar?.status).toBe("complete");
    expect(sidecar?.seats.reviewer_a).toBe("ok");
    expect(sidecar?.seats.reviewer_b).toBe("ok");
  });

  test("runRound without reusedCritiques still calls reviewers (regression guard)", async () => {
    const dirs = roundDirsFor(tmp, 3);
    const lead = createFakeAdapter({ revise: READY_REVISE });
    const revA = createFakeAdapter({ critique: CRIT_A });
    const revB = createFakeAdapter({ critique: CRIT_B });

    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 3,
      dirs,
      specText: "# SPEC v0.1\n\noriginal",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
    });
    expect(outcome.roundStopReason).toBe("ok");
  });
});

// ---------- partial-seat reuse ----------

// loadPersistedCritiques explicitly supports one recoverable seat + one
// absent (returns the absent seat as null). On the reuse path, runRound's
// reuseCritique() maps an `undefined` seat to a 'failed' SeatOutcome with
// errorDetail reason 'unknown'. The existing reuse test only covers
// both-seats-present; these lock down the partial path end-to-end.

function seedOnlySeatA(dir: ReturnType<typeof roundDirsFor>): void {
  mkdirSync(dir.roundDir, { recursive: true });
  writeFileSync(
    dir.codexPath,
    renderCritiqueMarkdown(CRIT_A, "reviewer_a"),
    "utf8",
  );
  // NOTE: claude.md intentionally NOT written.
}

/** Lead that succeeds on the first revise() and records what it saw. */
function recordingLead(): {
  adapter: Adapter;
  reviseCalls: () => number;
  lastReviews: () => readonly CritiqueOutput[];
} {
  let calls = 0;
  let captured: readonly CritiqueOutput[] = [];
  const adapter: Adapter = {
    ...createFakeAdapter({}),
    revise: (input: ReviseInput): Promise<ReviseOutput> => {
      calls += 1;
      captured = input.reviews;
      return Promise.resolve(READY_REVISE);
    },
  };
  return {
    adapter,
    reviseCalls: () => calls,
    lastReviews: () => captured,
  };
}

describe("resumable reviews — partial-seat reuse (one seat absent)", () => {
  test("loadPersistedCritiques returns {reviewer_a: <crit>, reviewer_b: null} when only codex.md present", () => {
    const dirs = roundDirsFor(tmp, 5);
    seedOnlySeatA(dirs);
    const loaded = loadPersistedCritiques(dirs);
    expect(loaded).not.toBeNull();
    expect(loaded?.reviewer_a?.summary).toBe("reviewer A summary");
    expect(loaded?.reviewer_b).toBeNull();
  });

  test("runRound revises with one reused critique, marks round 'partial', missing seat 'failed', reviewers SKIPPED", async () => {
    const dirs = roundDirsFor(tmp, 6);
    seedOnlySeatA(dirs);
    const reused = loadPersistedCritiques(dirs);
    expect(reused).not.toBeNull();
    if (reused === null) return;

    const { adapter: lead, reviseCalls, lastReviews } = recordingLead();
    // BOTH reviewers explode: the reuse path must not invoke either, even
    // though reviewer_b is absent (a failed seat would normally trigger
    // the whole-round reviewer retry — that retry must be skipped here).
    const revA = explodingReviewer();
    const revB = explodingReviewer();

    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 6,
      dirs,
      specText: "# SPEC v0.1\n\noriginal",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
      reusedCritiques: {
        ...(reused.reviewer_a !== null
          ? { reviewer_a: reused.reviewer_a }
          : {}),
        // reviewer_b deliberately omitted (absent on disk).
      },
    });

    // Lead revised exactly once with ONLY the surviving critique.
    expect(outcome.roundStopReason).toBe("ok");
    expect(reviseCalls()).toBe(1);
    expect(lastReviews().length).toBe(1);
    expect(lastReviews()[0]?.summary).toBe("reviewer A summary");

    // Surviving seat ok; missing seat failed with the reuse reason.
    expect(outcome.seats.reviewer_a.state).toBe("ok");
    expect(outcome.seats.reviewer_b.state).toBe("failed");
    expect(outcome.seats.reviewer_b.errorDetail?.reason).toBe("unknown");
    expect(outcome.seats.reviewer_b.errorDetail?.message).toContain(
      "no persisted critique to reuse",
    );

    // The reviewer whole-round retry must NOT have run on the reuse path.
    expect(outcome.reviewersRetried).toBe(false);

    // round.json is 'partial' (one seat ok, one failed) — not 'complete'.
    const sidecar = readRoundJson(dirs.roundJson);
    expect(sidecar?.status).toBe("partial");
    expect(sidecar?.seats.reviewer_a).toBe("ok");
    expect(sidecar?.seats.reviewer_b).not.toBe("ok");
  });
});

// ---------- FIX 4: don't record "failed" when the critique file exists ----------

// On the reuse path, a seat whose critique could NOT be recovered (its
// file is present on disk but, e.g., unparseable) was mapped to a 'failed'
// SeatOutcome and persistSeatResults then wrote round.json seat='failed' —
// even though codex.md / claude.md still exists on disk. That is
// misleading: post-hoc inspection sees a "failed" seat with a real
// critique file next to it. FIX 4: round.json must not record a misleading
// "failed" for a seat whose persisted critique file is present.

/** Seed BOTH critique files but make claude.md unparseable (no trailer). */
function seedSeatBUnparseable(dir: ReturnType<typeof roundDirsFor>): void {
  mkdirSync(dir.roundDir, { recursive: true });
  writeFileSync(
    dir.codexPath,
    renderCritiqueMarkdown(CRIT_A, "reviewer_a"),
    "utf8",
  );
  // claude.md EXISTS on disk but carries no machine-readable trailer, so
  // recoverCritiqueFromFile() returns null → not in reusedCritiques.
  writeFileSync(
    dir.claudePath,
    "# Reviewer B — Claude\n\nnot parseable\n",
    "utf8",
  );
}

describe("resumable reviews — FIX 4: no misleading 'failed' when critique file persists", () => {
  test("round.json does NOT record reviewer_b 'failed' when claude.md exists on disk", async () => {
    const dirs = roundDirsFor(tmp, 8);
    seedSeatBUnparseable(dirs);

    // Only reviewer_a is recoverable; reviewer_b's file exists but is
    // unparseable, so loadPersistedCritiques yields reviewer_b: null.
    const reused = loadPersistedCritiques(dirs);
    expect(reused).not.toBeNull();
    expect(reused?.reviewer_b).toBeNull();
    if (reused === null) return;

    const { adapter: lead } = recordingLead();
    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 8,
      dirs,
      specText: "# SPEC v0.1\n\noriginal",
      decisionsHistory: [],
      adapters: {
        lead,
        reviewerA: explodingReviewer(),
        reviewerB: explodingReviewer(),
      },
      reusedCritiques: {
        ...(reused.reviewer_a !== null
          ? { reviewer_a: reused.reviewer_a }
          : {}),
        // reviewer_b omitted: file present on disk but not recovered.
      },
    });
    expect(outcome.roundStopReason).toBe("ok");

    // The claude.md artifact is still on disk after the reuse.
    expect(readFileSync(dirs.claudePath, "utf8")).toContain("Reviewer B");

    // round.json must NOT misleadingly record reviewer_b as a failure
    // while its critique file persists on disk.
    const sidecar = readRoundJson(dirs.roundJson);
    const seatB = sidecar?.seats.reviewer_b;
    const failedStatus =
      seatB === "failed" ||
      (typeof seatB === "object" && seatB?.status === "failed");
    expect(failedStatus).toBe(false);
  });
});

// ---------- persisted-artifact idempotency on the reuse path ----------

// On the reuse path a reused 'ok' seat still carries its critique, so
// persistSeatResults re-writes codex.md / claude.md. Because
// renderCritiqueMarkdown is deterministic the rewrite is byte-identical;
// this test locks that idempotency down so a future change to the writer
// can't silently corrupt the very artifacts the resume depends on.
describe("resumable reviews — persisted critique files are byte-identical after a reuse-resume", () => {
  test("codex.md / claude.md are unchanged on disk after a successful reuse", async () => {
    const dirs = roundDirsFor(tmp, 7);
    seedPersistedCritiques(dirs);
    const beforeCodex = readFileSync(dirs.codexPath, "utf8");
    const beforeClaude = readFileSync(dirs.claudePath, "utf8");

    const reused = loadPersistedCritiques(dirs);
    expect(reused).not.toBeNull();
    if (reused === null) return;

    const { adapter: lead } = recordingLead();
    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 7,
      dirs,
      specText: "# SPEC v0.1\n\noriginal",
      decisionsHistory: [],
      // Reviewers must never run on reuse.
      adapters: {
        lead,
        reviewerA: explodingReviewer(),
        reviewerB: explodingReviewer(),
      },
      reusedCritiques: {
        ...(reused.reviewer_a !== null
          ? { reviewer_a: reused.reviewer_a }
          : {}),
        ...(reused.reviewer_b !== null
          ? { reviewer_b: reused.reviewer_b }
          : {}),
      },
    });
    expect(outcome.roundStopReason).toBe("ok");

    // The on-disk artifacts are byte-for-byte unchanged.
    expect(readFileSync(dirs.codexPath, "utf8")).toBe(beforeCodex);
    expect(readFileSync(dirs.claudePath, "utf8")).toBe(beforeClaude);
  });
});
