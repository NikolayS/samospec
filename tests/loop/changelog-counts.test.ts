// Copyright 2026 Nikolay Samokhvalov.

// RED tests for #59: changelog line "Round N reviews applied
// (decisions — accepted: X, rejected: Y, deferred: Z)" reflects actual
// counts from the round's decisions array.

import { test, expect, describe } from "bun:test";
import {
  countDecisions,
  type DecisionCounts,
} from "../../src/loop/decisions.ts";
import type { ReviewDecision } from "../../src/loop/decisions.ts";
import type { ReviseOutput } from "../../src/adapter/types.ts";

// Helper: build ReviewDecision[] from ReviseOutput.decisions
function toReviewDecisions(reviseOutput: ReviseOutput): ReviewDecision[] {
  if (!reviseOutput.decisions || reviseOutput.decisions.length === 0) {
    return [];
  }
  return reviseOutput.decisions.map((d) => ({
    finding_ref: d.finding_id ?? `${d.category}#?`,
    decision: d.verdict,
    rationale: d.rationale,
  }));
}

// Helper: format the changelog line (mirrors what the loop should produce)
function formatChangelogLine(
  roundNumber: number,
  counts: DecisionCounts,
): string {
  return (
    `Round ${String(roundNumber)} reviews applied ` +
    `(decisions — accepted: ${String(counts.accepted)}, ` +
    `rejected: ${String(counts.rejected)}, ` +
    `deferred: ${String(counts.deferred)})`
  );
}

describe("changelog counts from ReviseOutput.decisions", () => {
  test("all-accepted counts are correct", () => {
    const revise: ReviseOutput = {
      spec: "# S",
      ready: false,
      rationale: "r",
      usage: null,
      effort_used: "max",
      decisions: [
        {
          finding_id: "codex#1",
          category: "missing-requirement",
          verdict: "accepted",
          rationale: "r1",
        },
        {
          finding_id: "codex#2",
          category: "ambiguity",
          verdict: "accepted",
          rationale: "r2",
        },
      ],
    };
    const decisions = toReviewDecisions(revise);
    const counts = countDecisions(decisions);
    expect(counts.accepted).toBe(2);
    expect(counts.rejected).toBe(0);
    expect(counts.deferred).toBe(0);

    const line = formatChangelogLine(1, counts);
    expect(line).toContain("accepted: 2");
    expect(line).toContain("rejected: 0");
    expect(line).toContain("deferred: 0");
  });

  test("mixed verdicts counted correctly", () => {
    const revise: ReviseOutput = {
      spec: "# S",
      ready: false,
      rationale: "r",
      usage: null,
      effort_used: "max",
      decisions: [
        {
          finding_id: "codex#1",
          category: "missing-requirement",
          verdict: "accepted",
          rationale: "r1",
        },
        {
          finding_id: "claude#1",
          category: "weak-testing",
          verdict: "rejected",
          rationale: "r2",
        },
        {
          finding_id: "claude#2",
          category: "ambiguity",
          verdict: "deferred",
          rationale: "r3",
        },
        {
          finding_id: "codex#3",
          category: "missing-risk",
          verdict: "accepted",
          rationale: "r4",
        },
      ],
    };
    const decisions = toReviewDecisions(revise);
    const counts = countDecisions(decisions);
    expect(counts.accepted).toBe(2);
    expect(counts.rejected).toBe(1);
    expect(counts.deferred).toBe(1);

    const line = formatChangelogLine(3, counts);
    expect(line).toBe(
      "Round 3 reviews applied (decisions — accepted: 2, rejected: 1, deferred: 1)",
    );
  });

  test("empty decisions gives 0/0/0 counts", () => {
    const revise: ReviseOutput = {
      spec: "# S",
      ready: false,
      rationale: "r",
      usage: null,
      effort_used: "max",
      decisions: [],
    };
    const decisions = toReviewDecisions(revise);
    const counts = countDecisions(decisions);
    expect(counts.accepted).toBe(0);
    expect(counts.rejected).toBe(0);
    expect(counts.deferred).toBe(0);
  });

  test("missing decisions field gives 0/0/0 counts", () => {
    const revise: ReviseOutput = {
      spec: "# S",
      ready: false,
      rationale: "r",
      usage: null,
      effort_used: "max",
      // no decisions
    };
    const decisions = toReviewDecisions(revise);
    const counts = countDecisions(decisions);
    expect(counts.accepted).toBe(0);
    expect(counts.rejected).toBe(0);
    expect(counts.deferred).toBe(0);
  });

  test("changelog line format matches spec: 'Round N reviews applied (decisions — ...)'", () => {
    const counts: DecisionCounts = { accepted: 3, rejected: 1, deferred: 2 };
    const line = formatChangelogLine(5, counts);
    expect(line).toMatch(
      /^Round \d+ reviews applied \(decisions — accepted: \d+, rejected: \d+, deferred: \d+\)$/,
    );
  });

  test("all-rejected scenario", () => {
    const revise: ReviseOutput = {
      spec: "# S",
      ready: false,
      rationale: "r",
      usage: null,
      effort_used: "max",
      decisions: [
        { category: "unnecessary-scope", verdict: "rejected", rationale: "r1" },
        { category: "unnecessary-scope", verdict: "rejected", rationale: "r2" },
      ],
    };
    const decisions = toReviewDecisions(revise);
    const counts = countDecisions(decisions);
    expect(counts.accepted).toBe(0);
    expect(counts.rejected).toBe(2);
    expect(counts.deferred).toBe(0);
  });
});
