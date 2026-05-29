// Copyright 2026 Nikolay Samokhvalov.

// RED tests for reviewer context preservation wired into runRound.
//
// On round N>1 runRound must reconstruct each reviewer's prior context
// from PERSISTED artifacts (its own prior critique files + decisions.md)
// and pass it as `prior_context` on the CritiqueInput for that seat.
// Round 1 passes no prior_context.
//
// Crucially each seat gets ONLY its own history: reviewer A's
// prior_context carries codex.md findings, reviewer B's carries claude.md
// findings — never crossed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  Adapter,
  CritiqueInput,
  CritiqueOutput,
  ReviseInput,
  ReviseOutput,
} from "../../src/adapter/types.ts";
import {
  renderCritiqueMarkdown,
  roundDirsFor,
  runRound,
} from "../../src/loop/round.ts";

let slugDir: string;

beforeEach(() => {
  slugDir = mkdtempSync(path.join(tmpdir(), "samospec-round-prior-"));
});

afterEach(() => {
  rmSync(slugDir, { recursive: true, force: true });
});

const CRIT_A: CritiqueOutput = {
  findings: [
    {
      category: "missing-risk",
      text: "AAA codex prior finding",
      severity: "major",
    },
  ],
  summary: "A summary",
  suggested_next_version: "0.2",
  usage: null,
  effort_used: "max",
};

const CRIT_B: CritiqueOutput = {
  findings: [
    {
      category: "weak-testing",
      text: "BBB claude prior finding",
      severity: "minor",
    },
  ],
  summary: "B summary",
  suggested_next_version: "0.2",
  usage: null,
  effort_used: "max",
};

const READY_REVISE: ReviseOutput = {
  spec: "# SPEC v0.2\n\nrevised",
  ready: true,
  rationale: "[]",
  decisions: [],
  usage: null,
  effort_used: "max",
};

/** Reviewer adapter that records the CritiqueInput it was called with. */
function recordingReviewer(seat: "reviewer_a" | "reviewer_b"): {
  adapter: Adapter;
  lastInput: () => CritiqueInput | null;
} {
  let captured: CritiqueInput | null = null;
  const out = seat === "reviewer_a" ? CRIT_A : CRIT_B;
  const adapter: Adapter = {
    vendor: "fake",
    detect: () =>
      Promise.resolve({ installed: true, version: "x", path: "/x" }),
    auth_status: () => Promise.resolve({ authenticated: true }),
    supports_structured_output: () => true,
    supports_effort: () => true,
    models: () => Promise.resolve([{ id: "x", family: "fake" }]),
    ask: () => Promise.reject(new Error("unused")),
    critique: (input: CritiqueInput): Promise<CritiqueOutput> => {
      captured = input;
      return Promise.resolve(out);
    },
    revise: () => Promise.reject(new Error("unused")),
  };
  return { adapter, lastInput: () => captured };
}

function leadAdapter(): Adapter {
  return {
    vendor: "fake-lead",
    detect: () =>
      Promise.resolve({ installed: true, version: "x", path: "/x" }),
    auth_status: () => Promise.resolve({ authenticated: true }),
    supports_structured_output: () => true,
    supports_effort: () => true,
    models: () => Promise.resolve([{ id: "x", family: "fake" }]),
    ask: () => Promise.reject(new Error("unused")),
    critique: () => Promise.reject(new Error("unused")),
    revise: (_input: ReviseInput): Promise<ReviseOutput> =>
      Promise.resolve(READY_REVISE),
  };
}

function seedPriorRound(round: number): void {
  const dirs = roundDirsFor(slugDir, round);
  mkdirSync(dirs.roundDir, { recursive: true });
  writeFileSync(dirs.codexPath, renderCritiqueMarkdown(CRIT_A, "reviewer_a"));
  writeFileSync(dirs.claudePath, renderCritiqueMarkdown(CRIT_B, "reviewer_b"));
}

describe("runRound — reviewer context preservation wiring", () => {
  test("round 1 passes NO prior_context to either reviewer", async () => {
    const dirs = roundDirsFor(slugDir, 1);
    const a = recordingReviewer("reviewer_a");
    const b = recordingReviewer("reviewer_b");
    await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC v0.1",
      decisionsHistory: [],
      adapters: {
        lead: leadAdapter(),
        reviewerA: a.adapter,
        reviewerB: b.adapter,
      },
    });
    expect(a.lastInput()?.prior_context).toBeUndefined();
    expect(b.lastInput()?.prior_context).toBeUndefined();
  });

  test("round 2: each reviewer gets ONLY its own prior findings", async () => {
    seedPriorRound(1);
    const dirs = roundDirsFor(slugDir, 2);
    const a = recordingReviewer("reviewer_a");
    const b = recordingReviewer("reviewer_b");
    await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 2,
      dirs,
      specText: "# SPEC v0.2",
      decisionsHistory: [],
      adapters: {
        lead: leadAdapter(),
        reviewerA: a.adapter,
        reviewerB: b.adapter,
      },
    });

    const ctxA = a.lastInput()?.prior_context;
    const ctxB = b.lastInput()?.prior_context;
    expect(ctxA).toBeDefined();
    expect(ctxB).toBeDefined();

    // Reviewer A sees codex's prior finding, NOT claude's.
    expect(ctxA).toContain("AAA codex prior finding");
    expect(ctxA).not.toContain("BBB claude prior finding");

    // Reviewer B sees claude's prior finding, NOT codex's.
    expect(ctxB).toContain("BBB claude prior finding");
    expect(ctxB).not.toContain("AAA codex prior finding");
  });

  test("round 2 with decisions.md surfaces the lead's rulings to reviewers", async () => {
    seedPriorRound(1);
    writeFileSync(
      path.join(slugDir, "decisions.md"),
      [
        "# decisions",
        "",
        "## Round 1 — 2026-04-19",
        "",
        "- rejected missing-risk#1: out of scope for v0.2",
        "",
      ].join("\n"),
    );
    const dirs = roundDirsFor(slugDir, 2);
    const a = recordingReviewer("reviewer_a");
    const b = recordingReviewer("reviewer_b");
    await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 2,
      dirs,
      specText: "# SPEC v0.2",
      decisionsHistory: [],
      adapters: {
        lead: leadAdapter(),
        reviewerA: a.adapter,
        reviewerB: b.adapter,
      },
    });
    expect(a.lastInput()?.prior_context).toContain("rejected missing-risk#1");
  });
});
