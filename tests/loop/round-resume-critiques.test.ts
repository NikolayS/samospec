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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
