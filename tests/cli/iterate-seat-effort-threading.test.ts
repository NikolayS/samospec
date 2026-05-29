// Copyright 2026 Nikolay Samokhvalov.

// End-to-end seat-effort threading through `runIterate` (samospec
// robustness pass).
//
// `round-seat-effort.test.ts` proves `runRound` maps each seat's effort
// onto the matching adapter call. But nothing proved that the
// `seatEfforts` handed to `runIterate` actually REACHES `runRound` for a
// real round — the iterate loop could silently drop the field (the
// `...(input.seatEfforts !== undefined ? {...} : {})` spread at the
// runRound call site) and `round-seat-effort` would stay green because
// it calls runRound directly.
//
// These tests drive the real iterate loop over a fake repo with
// capturing adapters and assert that the per-seat effort threads all the
// way down to lead.revise() / reviewerA.critique() / reviewerB.critique()
// for an actual round — and lands on the RIGHT seat (a `--effort low`
// wired to the wrong seat, or a dropped `seatEfforts`, would fail here).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { runIterate, type IterateResolvers } from "../../src/cli/iterate.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-iterate-effort-"));
  initRepo(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function initRepo(cwd: string): void {
  spawnSync("git", ["init", "-q"], { cwd });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd });
  spawnSync("git", ["config", "user.name", "Test"], { cwd });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd });
  spawnSync("git", ["checkout", "-q", "-b", "samospec/refunds"], { cwd });
  writeFileSync(path.join(cwd, "README.md"), "seed\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd });
}

function seedSpec(cwd: string, slug: string): void {
  const slugDir = path.join(cwd, ".samo", "spec", slug);
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(path.join(slugDir, "SPEC.md"), "# SPEC\n\ncontent v0.1\n");
  writeFileSync(path.join(slugDir, "TLDR.md"), "# TLDR\n\n- old\n");
  writeFileSync(
    path.join(slugDir, "decisions.md"),
    "# decisions\n\n- No review-loop decisions yet.\n",
  );
  writeFileSync(
    path.join(slugDir, "changelog.md"),
    "# changelog\n\n## v0.1 — seed\n\n- initial\n",
  );
  writeFileSync(
    path.join(slugDir, "interview.json"),
    JSON.stringify({
      slug,
      persona: 'Veteran "refunds" expert',
      generated_at: "2026-04-19T12:00:00Z",
      questions: [],
      answers: [],
    }),
  );
  writeFileSync(
    path.join(slugDir, "context.json"),
    JSON.stringify({
      phase: "draft",
      files: [],
      risk_flags: [],
      budget: { phase: "draft", tokens_used: 0, tokens_budget: 0 },
    }),
  );
  const state: State = {
    slug,
    phase: "review_loop",
    round_index: 0,
    version: "0.1.0",
    persona: { skill: "refunds", accepted: true },
    push_consent: null,
    calibration: null,
    remote_stale: false,
    coupled_fallback: false,
    head_sha: null,
    round_state: "committed",
    exit: null,
    created_at: "2026-04-19T12:00:00Z",
    updated_at: "2026-04-19T12:00:00Z",
  };
  writeState(path.join(slugDir, "state.json"), state);
  spawnSync("git", ["add", "."], { cwd });
  spawnSync("git", ["commit", "-q", "-m", "spec(refunds): draft v0.1"], {
    cwd,
  });
}

const ACCEPT_RESOLVERS: IterateResolvers = {
  onManualEdit: () => Promise.resolve("incorporate"),
  onDegraded: () => Promise.resolve("accept"),
  onReviewerExhausted: () => Promise.resolve("abort"),
};

const DEFAULT_TIME_INPUTS = {
  sessionStartedAtMs: 0,
  nowMs: 0,
  maxWallClockMs: 60 * 60 * 1000,
  callTimeouts: {
    criticA_ms: 300_000,
    criticB_ms: 300_000,
    revise_ms: 600_000,
  },
};

const SAMPLE_CRITIQUE: CritiqueOutput = {
  findings: [
    {
      category: "ambiguity",
      text: "ambiguous about refunds",
      severity: "minor",
    },
  ],
  summary: "one ambiguity",
  suggested_next_version: "0.2",
  usage: null,
  effort_used: "max",
};

const READY_REVISE: ReviseOutput = {
  spec: "# SPEC\n\ncontent v0.2 revised\n",
  ready: true,
  rationale: JSON.stringify([
    { finding_ref: "codex#1", decision: "accepted", rationale: "yes" },
  ]),
  usage: null,
  effort_used: "max",
};

interface Captured {
  leadRevise?: EffortLevel;
  reviewerA?: EffortLevel;
  reviewerB?: EffortLevel;
}

function capturingAdapters(cap: Captured): {
  lead: Adapter;
  reviewerA: Adapter;
  reviewerB: Adapter;
} {
  const lead: Adapter = {
    ...createFakeAdapter({ revise: READY_REVISE }),
    revise: (input: ReviseInput): Promise<ReviseOutput> => {
      cap.leadRevise = input.opts.effort;
      return Promise.resolve(READY_REVISE);
    },
  };
  const reviewerA: Adapter = {
    ...createFakeAdapter({ critique: SAMPLE_CRITIQUE }),
    critique: (input: CritiqueInput): Promise<CritiqueOutput> => {
      cap.reviewerA = input.opts.effort;
      return Promise.resolve(SAMPLE_CRITIQUE);
    },
  };
  const reviewerB: Adapter = {
    ...createFakeAdapter({ critique: SAMPLE_CRITIQUE }),
    critique: (input: CritiqueInput): Promise<CritiqueOutput> => {
      cap.reviewerB = input.opts.effort;
      return Promise.resolve(SAMPLE_CRITIQUE);
    },
  };
  return { lead, reviewerA, reviewerB };
}

describe("runIterate — seatEfforts threads through to the round seats", () => {
  test("a distinct per-seat mapping reaches the right adapter call (catches wrong-seat wiring)", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);
    const cap: Captured = {};
    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: capturingAdapters(cap),
      maxRounds: 1,
      seatEfforts: { lead: "high", reviewer_a: "low", reviewer_b: "off" },
      ...DEFAULT_TIME_INPUTS,
    });
    expect(res.exitCode).toBe(0);
    expect(res.roundsRun).toBe(1);
    // Each seat's effort must land on ITS OWN adapter call — not a
    // neighbour's. If iterate dropped seatEfforts these would be
    // "high"; if it crossed wires the values would be swapped.
    expect(cap.leadRevise).toBe("high");
    expect(cap.reviewerA).toBe("low");
    expect(cap.reviewerB).toBe("off");
  });

  test("a uniform --effort value (as the flag yields) lands on every seat", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);
    const cap: Captured = {};
    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: capturingAdapters(cap),
      maxRounds: 1,
      seatEfforts: { lead: "low", reviewer_a: "low", reviewer_b: "low" },
      ...DEFAULT_TIME_INPUTS,
    });
    expect(res.exitCode).toBe(0);
    expect(cap.leadRevise).toBe("low");
    expect(cap.reviewerA).toBe("low");
    expect(cap.reviewerB).toBe("low");
  });

  test("omitting seatEfforts defaults every seat to high (NOT max) for a real round", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);
    const cap: Captured = {};
    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: capturingAdapters(cap),
      maxRounds: 1,
      ...DEFAULT_TIME_INPUTS,
    });
    expect(res.exitCode).toBe(0);
    expect(cap.leadRevise).toBe("high");
    expect(cap.reviewerA).toBe("high");
    expect(cap.reviewerB).toBe("high");
  });
});
