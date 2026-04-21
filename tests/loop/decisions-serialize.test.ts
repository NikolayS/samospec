// Copyright 2026 Nikolay Samokhvalov.

// RED tests for #59: given a ReviseOutput.decisions array from a fake
// round, decisions.md is updated with one line per decision under the
// round header. When decisions is absent, falls back to "no decisions
// recorded this round".

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendRoundDecisions,
  reviseDecisionsToReviewDecisions,
  type AppendRoundDecisionsInput,
} from "../../src/loop/decisions.ts";
import type { ReviseOutput } from "../../src/adapter/types.ts";

// Build decisions from ReviseOutput.decisions via the real exported
// helper so this file stays aligned with production behavior — notably
// the `#?`-placeholder-free substitution landed in #95.
function decisionsFromReviseOutput(
  reviseOutput: ReviseOutput,
): AppendRoundDecisionsInput["entries"] {
  return reviseDecisionsToReviewDecisions(reviseOutput.decisions);
}

let tmpDir: string;
let decisionsFile: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `samospec-test-${Date.now()}-${Math.random()}`);
  mkdirSync(tmpDir, { recursive: true });
  decisionsFile = join(tmpDir, "decisions.md");
});

afterEach(() => {
  try {
    if (existsSync(decisionsFile)) unlinkSync(decisionsFile);
  } catch {
    // best effort cleanup
  }
});

describe("decisions.md serialization from ReviseOutput.decisions", () => {
  test("writes accepted decision with verdict and rationale", () => {
    const reviseOutput: ReviseOutput = {
      spec: "# Spec\nContent.",
      ready: false,
      rationale: "Applied findings.",
      usage: null,
      effort_used: "max",
      decisions: [
        {
          finding_id: "codex#1",
          category: "missing-requirement",
          verdict: "accepted",
          rationale: "Added rate-limit handling section.",
        },
      ],
    };

    const entries = decisionsFromReviseOutput(reviseOutput);
    appendRoundDecisions({
      file: decisionsFile,
      roundNumber: 1,
      now: "2026-04-19T10:00:00Z",
      entries,
    });

    const content = readFileSync(decisionsFile, "utf8");
    expect(content).toContain("## Round 1");
    expect(content).toContain("accepted");
    expect(content).toContain("codex#1");
    expect(content).toContain("Added rate-limit handling section.");
  });

  test("writes rejected decision with rationale", () => {
    const reviseOutput: ReviseOutput = {
      spec: "# Spec\nContent.",
      ready: false,
      rationale: "Rejected some.",
      usage: null,
      effort_used: "max",
      decisions: [
        {
          finding_id: "claude#1",
          category: "unnecessary-scope",
          verdict: "rejected",
          rationale: "Out of v1 scope per product owner decision.",
        },
      ],
    };

    const entries = decisionsFromReviseOutput(reviseOutput);
    appendRoundDecisions({
      file: decisionsFile,
      roundNumber: 2,
      now: "2026-04-19T11:00:00Z",
      entries,
    });

    const content = readFileSync(decisionsFile, "utf8");
    expect(content).toContain("rejected");
    expect(content).toContain("Out of v1 scope per product owner decision.");
  });

  test("writes deferred decision", () => {
    const reviseOutput: ReviseOutput = {
      spec: "# Spec\nContent.",
      ready: false,
      rationale: "Deferred some.",
      usage: null,
      effort_used: "max",
      decisions: [
        {
          finding_id: "codex#2",
          category: "weak-testing",
          verdict: "deferred",
          rationale: "Will address in sprint 2.",
        },
      ],
    };

    const entries = decisionsFromReviseOutput(reviseOutput);
    appendRoundDecisions({
      file: decisionsFile,
      roundNumber: 1,
      now: "2026-04-19T10:00:00Z",
      entries,
    });

    const content = readFileSync(decisionsFile, "utf8");
    expect(content).toContain("deferred");
    expect(content).toContain("Will address in sprint 2.");
  });

  test("falls back to 'no decisions recorded this round' when decisions absent", () => {
    const reviseOutput: ReviseOutput = {
      spec: "# Spec\nContent.",
      ready: false,
      rationale: "One more round.",
      usage: null,
      effort_used: "max",
      // no decisions field
    };

    const entries = decisionsFromReviseOutput(reviseOutput);
    appendRoundDecisions({
      file: decisionsFile,
      roundNumber: 1,
      now: "2026-04-19T10:00:00Z",
      entries,
    });

    const content = readFileSync(decisionsFile, "utf8");
    expect(content).toContain("no decisions recorded this round");
  });

  test("falls back when decisions array is empty", () => {
    const reviseOutput: ReviseOutput = {
      spec: "# Spec\nContent.",
      ready: false,
      rationale: "Empty decisions.",
      usage: null,
      effort_used: "max",
      decisions: [],
    };

    const entries = decisionsFromReviseOutput(reviseOutput);
    appendRoundDecisions({
      file: decisionsFile,
      roundNumber: 1,
      now: "2026-04-19T10:00:00Z",
      entries,
    });

    const content = readFileSync(decisionsFile, "utf8");
    expect(content).toContain("no decisions recorded this round");
  });

  test("multiple decisions each get their own line", () => {
    const reviseOutput: ReviseOutput = {
      spec: "# Spec\nContent.",
      ready: false,
      rationale: "Multiple decisions.",
      usage: null,
      effort_used: "max",
      decisions: [
        {
          finding_id: "codex#1",
          category: "missing-requirement",
          verdict: "accepted",
          rationale: "Applied.",
        },
        {
          finding_id: "claude#1",
          category: "weak-testing",
          verdict: "rejected",
          rationale: "Already covered.",
        },
        {
          finding_id: "claude#2",
          category: "ambiguity",
          verdict: "deferred",
          rationale: "Deferred to next sprint.",
        },
      ],
    };

    const entries = decisionsFromReviseOutput(reviseOutput);
    appendRoundDecisions({
      file: decisionsFile,
      roundNumber: 3,
      now: "2026-04-19T12:00:00Z",
      entries,
    });

    const content = readFileSync(decisionsFile, "utf8");
    // Each decision should be on its own line starting with '-'
    const lines = content.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });

  test("multiple rounds accumulate in the file", () => {
    const entries1 = decisionsFromReviseOutput({
      spec: "# Spec",
      ready: false,
      rationale: "r1",
      usage: null,
      effort_used: "max",
      decisions: [
        {
          finding_id: "codex#1",
          category: "missing-requirement",
          verdict: "accepted",
          rationale: "r1 decision.",
        },
      ],
    });
    appendRoundDecisions({
      file: decisionsFile,
      roundNumber: 1,
      now: "2026-04-19T10:00:00Z",
      entries: entries1,
    });

    const entries2 = decisionsFromReviseOutput({
      spec: "# Spec v2",
      ready: true,
      rationale: "r2",
      usage: null,
      effort_used: "max",
      decisions: [
        {
          finding_id: "claude#1",
          category: "weak-testing",
          verdict: "rejected",
          rationale: "r2 decision.",
        },
      ],
    });
    appendRoundDecisions({
      file: decisionsFile,
      roundNumber: 2,
      now: "2026-04-19T11:00:00Z",
      entries: entries2,
    });

    const content = readFileSync(decisionsFile, "utf8");
    expect(content).toContain("## Round 1");
    expect(content).toContain("## Round 2");
    expect(content).toContain("r1 decision.");
    expect(content).toContain("r2 decision.");
  });
});
