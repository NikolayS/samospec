// Copyright 2026 Nikolay Samokhvalov.

// Unified per-seat effort threading through runRound (samospec
// robustness pass).
//
// Before the unified-effort knob, the round runner hardcoded
// `effort: "max"` for every reviewer critique() and lead revise() call.
// Now `runRound` accepts `seatEfforts` (resolved by the CLI:
// `--effort` flag > per-seat config > unified medium) and threads each
// seat's effort into the matching adapter call. Omitted seats fall back
// to the unified `medium` default (NOT "max").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type {
  Adapter,
  CritiqueInput,
  CritiqueOutput,
  EffortLevel,
  ReviseInput,
  ReviseOutput,
} from "../../src/adapter/types.ts";
import { roundDirsFor, runRound } from "../../src/loop/round.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-round-effort-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const SAMPLE_CRITIQUE: CritiqueOutput = {
  findings: [
    { category: "missing-risk", text: "no rate limits", severity: "major" },
  ],
  summary: "one finding",
  suggested_next_version: "0.2",
  usage: null,
  effort_used: "max",
};

const READY_REVISE: ReviseOutput = {
  spec: "# SPEC\n\nrevised spec body",
  ready: true,
  rationale: "ok",
  usage: null,
  effort_used: "max",
};

interface Captured {
  leadRevise?: EffortLevel;
  reviewerA?: EffortLevel;
  reviewerB?: EffortLevel;
}

function makeCapturingAdapters(cap: Captured): {
  lead: Adapter;
  reviewerA: Adapter;
  reviewerB: Adapter;
} {
  const leadBase = createFakeAdapter({ revise: READY_REVISE });
  const lead: Adapter = {
    ...leadBase,
    revise: (input: ReviseInput): Promise<ReviseOutput> => {
      cap.leadRevise = input.opts.effort;
      return Promise.resolve(READY_REVISE);
    },
  };
  const aBase = createFakeAdapter({ critique: SAMPLE_CRITIQUE });
  const reviewerA: Adapter = {
    ...aBase,
    critique: (input: CritiqueInput): Promise<CritiqueOutput> => {
      cap.reviewerA = input.opts.effort;
      return Promise.resolve(SAMPLE_CRITIQUE);
    },
  };
  const bBase = createFakeAdapter({ critique: SAMPLE_CRITIQUE });
  const reviewerB: Adapter = {
    ...bBase,
    critique: (input: CritiqueInput): Promise<CritiqueOutput> => {
      cap.reviewerB = input.opts.effort;
      return Promise.resolve(SAMPLE_CRITIQUE);
    },
  };
  return { lead, reviewerA, reviewerB };
}

describe("runRound — per-seat effort threading", () => {
  test("defaults to medium for every seat when seatEfforts omitted (was max)", async () => {
    const cap: Captured = {};
    const adapters = makeCapturingAdapters(cap);
    await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs: roundDirsFor(tmp, 1),
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters,
    });
    expect(cap.leadRevise).toBe("medium");
    expect(cap.reviewerA).toBe("medium");
    expect(cap.reviewerB).toBe("medium");
  });

  test("threads each seat's resolved effort into its adapter call", async () => {
    const cap: Captured = {};
    const adapters = makeCapturingAdapters(cap);
    await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs: roundDirsFor(tmp, 1),
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters,
      seatEfforts: {
        lead: "high",
        reviewer_a: "low",
        reviewer_b: "off",
      },
    });
    expect(cap.leadRevise).toBe("high");
    expect(cap.reviewerA).toBe("low");
    expect(cap.reviewerB).toBe("off");
  });

  test("a uniform flag value (max) lands on every seat", async () => {
    const cap: Captured = {};
    const adapters = makeCapturingAdapters(cap);
    await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs: roundDirsFor(tmp, 1),
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters,
      seatEfforts: { lead: "max", reviewer_a: "max", reviewer_b: "max" },
    });
    expect(cap.leadRevise).toBe("max");
    expect(cap.reviewerA).toBe("max");
    expect(cap.reviewerB).toBe("max");
  });
});
