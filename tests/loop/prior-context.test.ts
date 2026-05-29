// Copyright 2026 Nikolay Samokhvalov.

// RED tests for reviewer context preservation (samospec robustness pass).
//
// Each reviewer must "remember what it noticed on previous rounds" so the
// review loop converges instead of re-litigating. Prior context is
// reconstructed from PERSISTED artifacts (so it survives resume), not from
// live sessions:
//   - Reviewer A reads its OWN prior critiques from reviews/rNN/codex.md.
//   - Reviewer B reads its OWN prior critiques from reviews/rNN/claude.md.
//   - Both read the lead's per-finding rulings from decisions.md.
//
// Assertions:
//   1. Round 1 (no history) yields no prior context (undefined).
//   2. On round N>1, each seat's prior context contains ONLY its own prior
//      findings (codex sees codex, claude sees claude — never crossed).
//   3. The lead's decisions from decisions.md are included.
//   4. Output is bounded: only the last few rounds, capped length.
//   5. Missing / partial / unparseable files degrade gracefully (no throw,
//      no prior context).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CritiqueOutput } from "../../src/adapter/types.ts";
import {
  PRIOR_CONTEXT_MAX_CHARS,
  PRIOR_CONTEXT_MAX_ROUNDS,
  buildPriorContext,
} from "../../src/loop/prior-context.ts";
import { renderCritiqueMarkdown, roundDirsFor } from "../../src/loop/round.ts";

let slugDir: string;

beforeEach(() => {
  slugDir = mkdtempSync(path.join(tmpdir(), "samospec-prior-ctx-"));
});

afterEach(() => {
  rmSync(slugDir, { recursive: true, force: true });
});

const CRIT_A: CritiqueOutput = {
  findings: [
    {
      category: "missing-risk",
      text: "AAA no auth story on the admin endpoint",
      severity: "major",
    },
  ],
  summary: "reviewer A round summary",
  suggested_next_version: "0.2",
  usage: null,
  effort_used: "max",
};

const CRIT_B: CritiqueOutput = {
  findings: [
    {
      category: "weak-testing",
      text: "BBB no red/green TDD plan for the importer",
      severity: "minor",
    },
  ],
  summary: "reviewer B round summary",
  suggested_next_version: "0.2",
  usage: null,
  effort_used: "max",
};

function seedRound(round: number): void {
  const dirs = roundDirsFor(slugDir, round);
  mkdirSync(dirs.roundDir, { recursive: true });
  writeFileSync(dirs.codexPath, renderCritiqueMarkdown(CRIT_A, "reviewer_a"));
  writeFileSync(dirs.claudePath, renderCritiqueMarkdown(CRIT_B, "reviewer_b"));
}

function seedDecisions(body: string): void {
  writeFileSync(path.join(slugDir, "decisions.md"), body);
}

describe("buildPriorContext — per-reviewer artifact-reconstructed memory", () => {
  test("round 1 yields no prior context (undefined)", () => {
    expect(
      buildPriorContext({ slugDir, currentRound: 1, seat: "reviewer_a" }),
    ).toBeUndefined();
    expect(
      buildPriorContext({ slugDir, currentRound: 1, seat: "reviewer_b" }),
    ).toBeUndefined();
  });

  test("round 2 reviewer A sees ONLY its own (codex) prior findings", () => {
    seedRound(1);
    const ctx = buildPriorContext({
      slugDir,
      currentRound: 2,
      seat: "reviewer_a",
    });
    expect(ctx).toBeDefined();
    expect(ctx).toContain("AAA no auth story");
    // Must NOT leak reviewer B's findings.
    expect(ctx).not.toContain("BBB no red/green TDD");
  });

  test("round 2 reviewer B sees ONLY its own (claude) prior findings", () => {
    seedRound(1);
    const ctx = buildPriorContext({
      slugDir,
      currentRound: 2,
      seat: "reviewer_b",
    });
    expect(ctx).toBeDefined();
    expect(ctx).toContain("BBB no red/green TDD");
    expect(ctx).not.toContain("AAA no auth story");
  });

  test("includes the lead's decisions from decisions.md", () => {
    seedRound(1);
    seedDecisions(
      [
        "# decisions",
        "",
        "## Round 1 — 2026-04-19",
        "",
        "- deferred missing-risk#1: punted auth hardening to v0.3",
        "",
      ].join("\n"),
    );
    const ctx = buildPriorContext({
      slugDir,
      currentRound: 2,
      seat: "reviewer_a",
    });
    expect(ctx).toBeDefined();
    expect(ctx).toContain("deferred missing-risk#1");
    expect(ctx).toContain("punted auth hardening");
  });

  test("only the last PRIOR_CONTEXT_MAX_ROUNDS rounds are included", () => {
    // Seed more rounds than the cap, with a marker per round so we can
    // assert the oldest is dropped.
    const total = PRIOR_CONTEXT_MAX_ROUNDS + 2;
    for (let r = 1; r <= total; r += 1) {
      const dirs = roundDirsFor(slugDir, r);
      mkdirSync(dirs.roundDir, { recursive: true });
      const crit: CritiqueOutput = {
        ...CRIT_A,
        findings: [
          {
            category: "ambiguity",
            text: `ROUND-${r}-MARKER finding text`,
            severity: "minor",
          },
        ],
      };
      writeFileSync(dirs.codexPath, renderCritiqueMarkdown(crit, "reviewer_a"));
    }
    const ctx = buildPriorContext({
      slugDir,
      currentRound: total + 1,
      seat: "reviewer_a",
    });
    expect(ctx).toBeDefined();
    // Newest round before current is included.
    expect(ctx).toContain(`ROUND-${total}-MARKER`);
    // Oldest round (round 1) must be dropped by the cap.
    expect(ctx).not.toContain("ROUND-1-MARKER");
  });

  test("output is length-bounded (<= PRIOR_CONTEXT_MAX_CHARS)", () => {
    // Seed a round with a very long finding so the raw content would blow
    // past the cap if uncapped.
    const dirs = roundDirsFor(slugDir, 1);
    mkdirSync(dirs.roundDir, { recursive: true });
    const huge: CritiqueOutput = {
      ...CRIT_A,
      findings: [
        {
          category: "ambiguity",
          text: "X".repeat(PRIOR_CONTEXT_MAX_CHARS * 4),
          severity: "minor",
        },
      ],
    };
    writeFileSync(dirs.codexPath, renderCritiqueMarkdown(huge, "reviewer_a"));
    const ctx = buildPriorContext({
      slugDir,
      currentRound: 2,
      seat: "reviewer_a",
    });
    expect(ctx).toBeDefined();
    expect((ctx ?? "").length).toBeLessThanOrEqual(PRIOR_CONTEXT_MAX_CHARS);
  });

  test("missing prior files degrade gracefully (undefined, no throw)", () => {
    // currentRound=3 but nothing on disk.
    expect(() =>
      buildPriorContext({ slugDir, currentRound: 3, seat: "reviewer_a" }),
    ).not.toThrow();
    expect(
      buildPriorContext({ slugDir, currentRound: 3, seat: "reviewer_a" }),
    ).toBeUndefined();
  });

  test("unparseable critique file degrades gracefully (undefined, no throw)", () => {
    const dirs = roundDirsFor(slugDir, 1);
    mkdirSync(dirs.roundDir, { recursive: true });
    // No samospec:critique trailer → recoverCritiqueFromFile returns null.
    writeFileSync(
      dirs.codexPath,
      "# Reviewer A — Codex\n\nnot machine-readable",
    );
    expect(() =>
      buildPriorContext({ slugDir, currentRound: 2, seat: "reviewer_a" }),
    ).not.toThrow();
    expect(
      buildPriorContext({ slugDir, currentRound: 2, seat: "reviewer_a" }),
    ).toBeUndefined();
  });

  test("partial history: one missing round still yields the present one", () => {
    // Round 1 missing, round 2 present, building for round 3.
    seedRound(2);
    const ctx = buildPriorContext({
      slugDir,
      currentRound: 3,
      seat: "reviewer_a",
    });
    expect(ctx).toBeDefined();
    expect(ctx).toContain("AAA no auth story");
  });
});
