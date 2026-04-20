// Copyright 2026 Nikolay Samokhvalov.

// SPEC §5 Phase 1 + §11 preflight cost estimate.
//
// Red-first contract tests for `computePreflight` + its pretty-printer.
// These exercise:
//   1. Below calibration floor (sample_count < 3) -> defaults + "first
//      runs" inline annotation.
//   2. Blended band (3 <= sample_count < 10) -> weighted mix with defaults.
//   3. Calibrated band (sample_count >= 10) -> calibration dominates.
//   4. `likelyUsd` is the P50 AT `M_likely` rounds, NOT the midpoint of
//      `rangeLow..rangeHigh`. Skewed range case asserts the P50 value
//      sits where `M_likely` says it does.
//   5. Subscription-auth: per-adapter cost string + warning + `likelyUsd`
//      excludes unpriced adapter.
//   6. Pretty-printer includes range, likely, per-adapter, warnings,
//      and the "first runs" inline when below-floor.

import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../../src/cli/init.ts";
import {
  computePreflight,
  formatPreflight,
  type PreflightAdapter,
  type PreflightConfig,
} from "../../src/policy/preflight.ts";

// ---------- helpers ----------

function mkConfig(overrides: Partial<PreflightConfig> = {}): PreflightConfig {
  // Use the init defaults as our baseline then layer test-specific overrides.
  const baseline: PreflightConfig = {
    adapters: {
      lead: { ...DEFAULT_CONFIG.adapters.lead },
      reviewer_a: { ...DEFAULT_CONFIG.adapters.reviewer_a },
      reviewer_b: { ...DEFAULT_CONFIG.adapters.reviewer_b },
    },
    budget: { ...DEFAULT_CONFIG.budget },
    calibration: null,
  };
  return { ...baseline, ...overrides };
}

function mkAdapter(
  id: string,
  vendor: string,
  subscription_auth: boolean,
  role: "lead" | "reviewer_a" | "reviewer_b",
): PreflightAdapter {
  return { id, vendor, role, subscription_auth };
}

// A three-seat default fleet matching the spec's pinned defaults.
const LEAD = mkAdapter("lead", "claude", false, "lead");
const REVA = mkAdapter("reviewer_a", "codex", false, "reviewer_a");
const REVB = mkAdapter("reviewer_b", "claude", false, "reviewer_b");
const FLEET = [LEAD, REVA, REVB];

// ---------- below floor ----------

describe("computePreflight — below calibration floor (sample_count < 3)", () => {
  test("returns estimate with `belowFloor: true` and no calibration used", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, FLEET);
    expect(r.belowFloor).toBe(true);
    expect(r.sampleCount).toBe(0);
  });

  test("at 2 samples: still below floor", () => {
    const cfg = mkConfig({
      calibration: {
        sample_count: 2,
        tokens_per_round: [100_000, 120_000],
        rounds_to_converge: [5, 6],
        cost_per_run_usd: [3, 4],
      },
    });
    const r = computePreflight(cfg, FLEET);
    expect(r.belowFloor).toBe(true);
  });

  test("pretty-printer emits 'first runs; estimate is approximate' inline", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, FLEET);
    const text = formatPreflight(r);
    expect(text).toContain("first runs; estimate is approximate");
  });

  test("pretty-printer includes range + likely line + per-adapter list", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, FLEET);
    const text = formatPreflight(r);
    expect(text).toMatch(/estimated range: \$[\d.]+–\$[\d.]+, likely \$[\d.]+/);
    expect(text).toContain("lead");
    expect(text).toContain("reviewer_a");
    expect(text).toContain("reviewer_b");
  });

  test("rangeLow < likely < rangeHigh and all positive", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, FLEET);
    expect(r.rangeLowUsd).toBeGreaterThan(0);
    expect(r.rangeHighUsd).toBeGreaterThan(r.rangeLowUsd);
    expect(r.likelyUsd).toBeGreaterThan(r.rangeLowUsd);
    expect(r.likelyUsd).toBeLessThan(r.rangeHighUsd);
  });
});

// ---------- likelyUsd is P50 at M_likely, not midpoint of range ----------

describe("computePreflight — likelyUsd is P50 at M_likely", () => {
  test("below floor with default M=10: M_likely=5, NOT midpoint of range", () => {
    // rangeLow = 1 round, rangeHigh = M rounds. Arithmetic midpoint
    // would be (low + high) / 2 = ~5.5 rounds if linearly scaled.
    // M_likely = M/2 = 5 rounds — so likely < arithmetic midpoint
    // because the per-round scaling is not perfectly linear (draft is
    // a one-time lead cost).
    const cfg = mkConfig();
    const r = computePreflight(cfg, FLEET);
    const midpoint = (r.rangeLowUsd + r.rangeHighUsd) / 2;
    // Assert NOT equal, with a meaningful delta.
    expect(Math.abs(r.likelyUsd - midpoint)).toBeGreaterThan(0.01);
  });

  test("with 10+ samples and a mean_rounds_to_converge well below M/2, likely < arithmetic midpoint", () => {
    const cfg = mkConfig({
      calibration: {
        // 10 samples, every one converged in 3 rounds.
        sample_count: 10,
        tokens_per_round: new Array<number>(10).fill(100_000),
        rounds_to_converge: new Array<number>(10).fill(3),
        cost_per_run_usd: new Array<number>(10).fill(2.5),
      },
    });
    const r = computePreflight(cfg, FLEET);
    const midpoint = (r.rangeLowUsd + r.rangeHighUsd) / 2;
    expect(r.likelyUsd).toBeLessThan(midpoint);
  });
});

// ---------- blended (3..9 samples) ----------

describe("computePreflight — blended band (3..9 samples)", () => {
  test("at 3 samples: effective = 30% calibration + 70% defaults", () => {
    // Use a calibration strongly different from defaults so the blend
    // is observable in the output.
    const heavyCal = mkConfig({
      calibration: {
        sample_count: 3,
        tokens_per_round: [1_000_000, 1_000_000, 1_000_000], // high
        rounds_to_converge: [3, 3, 3], // few rounds
        cost_per_run_usd: [100, 100, 100],
      },
    });
    const r3 = computePreflight(heavyCal, FLEET);
    expect(r3.belowFloor).toBe(false);
    expect(r3.sampleCount).toBe(3);
    expect(r3.blendWeight).toBeCloseTo(0.3, 5);
  });

  test("at 7 samples: effective = 70% calibration + 30% defaults", () => {
    const cfg = mkConfig({
      calibration: {
        sample_count: 7,
        tokens_per_round: new Array<number>(7).fill(500_000),
        rounds_to_converge: new Array<number>(7).fill(4),
        cost_per_run_usd: new Array<number>(7).fill(10),
      },
    });
    const r = computePreflight(cfg, FLEET);
    expect(r.blendWeight).toBeCloseTo(0.7, 5);
  });

  test("pretty-printer for blended band OMITS 'first runs; estimate is approximate'", () => {
    const cfg = mkConfig({
      calibration: {
        sample_count: 5,
        tokens_per_round: new Array<number>(5).fill(100_000),
        rounds_to_converge: new Array<number>(5).fill(4),
        cost_per_run_usd: new Array<number>(5).fill(3),
      },
    });
    const r = computePreflight(cfg, FLEET);
    const text = formatPreflight(r);
    expect(text).not.toContain("first runs; estimate is approximate");
  });
});

// ---------- calibrated (>=10 samples) ----------

describe("computePreflight — calibrated (sample_count >= 10)", () => {
  test("at 10 samples: calibration dominates (weight=1.0)", () => {
    const cfg = mkConfig({
      calibration: {
        sample_count: 10,
        tokens_per_round: new Array<number>(10).fill(200_000),
        rounds_to_converge: new Array<number>(10).fill(5),
        cost_per_run_usd: new Array<number>(10).fill(5),
      },
    });
    const r = computePreflight(cfg, FLEET);
    expect(r.blendWeight).toBeCloseTo(1.0, 5);
  });

  test("at 20 samples: still clamps to weight=1.0", () => {
    const cfg = mkConfig({
      calibration: {
        sample_count: 20,
        tokens_per_round: new Array<number>(20).fill(200_000),
        rounds_to_converge: new Array<number>(20).fill(5),
        cost_per_run_usd: new Array<number>(20).fill(5),
      },
    });
    const r = computePreflight(cfg, FLEET);
    expect(r.blendWeight).toBeCloseTo(1.0, 5);
  });

  test("calibration mean_rounds_to_converge drives M_likely", () => {
    const fastCal = mkConfig({
      calibration: {
        sample_count: 10,
        tokens_per_round: new Array<number>(10).fill(100_000),
        rounds_to_converge: new Array<number>(10).fill(2), // very fast
        cost_per_run_usd: new Array<number>(10).fill(1.5),
      },
    });
    const slowCal = mkConfig({
      calibration: {
        sample_count: 10,
        tokens_per_round: new Array<number>(10).fill(100_000),
        rounds_to_converge: new Array<number>(10).fill(9), // slow
        cost_per_run_usd: new Array<number>(10).fill(5),
      },
    });
    const rFast = computePreflight(fastCal, FLEET);
    const rSlow = computePreflight(slowCal, FLEET);
    // Slower convergence → higher likely.
    expect(rSlow.likelyUsd).toBeGreaterThan(rFast.likelyUsd);
  });
});

// ---------- subscription-auth escape ----------

describe("computePreflight — subscription-auth escape", () => {
  test("per-adapter cost is the 'unknown — subscription auth' string", () => {
    const subLead = mkAdapter("lead", "claude", true, "lead");
    const cfg = mkConfig();
    const r = computePreflight(cfg, [subLead, REVA, REVB]);
    const perLead = r.perAdapter["lead"];
    expect(perLead).toBeDefined();
    expect(perLead?.usd).toBe("unknown — subscription auth");
  });

  test("warning lists how many adapters are under subscription-auth", () => {
    const subLead = mkAdapter("lead", "claude", true, "lead");
    const subRevB = mkAdapter("reviewer_b", "claude", true, "reviewer_b");
    const cfg = mkConfig();
    const r = computePreflight(cfg, [subLead, REVA, subRevB]);
    expect(r.warnings.some((w) => w.includes("subscription"))).toBe(true);
    expect(
      r.warnings.some((w) => w.includes("2") && /subscription/i.test(w)),
    ).toBe(true);
  });

  test("likelyUsd reflects only priced adapters (excludes subscription-auth)", () => {
    const allPriced = [LEAD, REVA, REVB];
    const rAll = computePreflight(mkConfig(), allPriced);

    const subLead = mkAdapter("lead", "claude", true, "lead");
    const oneSub = [subLead, REVA, REVB];
    const rSub = computePreflight(mkConfig(), oneSub);

    // Dropping the lead's priced contribution must shrink the likely.
    expect(rSub.likelyUsd).toBeLessThan(rAll.likelyUsd);
  });

  test("pretty-printer renders 'unknown — subscription auth' for the subbed adapter line", () => {
    const subLead = mkAdapter("lead", "claude", true, "lead");
    const cfg = mkConfig();
    const r = computePreflight(cfg, [subLead, REVA, REVB]);
    const text = formatPreflight(r);
    expect(text).toContain("unknown — subscription auth");
  });
});

// ---------- per-adapter breakdown + tokens ----------

describe("computePreflight — per-adapter breakdown", () => {
  test("each adapter entry reports a positive token estimate", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, FLEET);
    for (const id of ["lead", "reviewer_a", "reviewer_b"] as const) {
      const entry = r.perAdapter[id];
      expect(entry).toBeDefined();
      expect(entry?.tokens).toBeGreaterThan(0);
    }
  });

  test("lead spend > reviewer spend (lead carries draft + revision per round)", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, FLEET);
    const lead = r.perAdapter["lead"];
    const revA = r.perAdapter["reviewer_a"];
    expect(lead).toBeDefined();
    expect(revA).toBeDefined();
    expect(lead?.tokens).toBeGreaterThan(revA?.tokens ?? Infinity);
  });
});

// ---------- shape / types ----------

describe("computePreflight — return shape", () => {
  test("has the required top-level keys", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, FLEET);
    expect(r).toHaveProperty("rangeLowUsd");
    expect(r).toHaveProperty("rangeHighUsd");
    expect(r).toHaveProperty("likelyUsd");
    expect(r).toHaveProperty("perAdapter");
    expect(r).toHaveProperty("warnings");
    expect(Array.isArray(r.warnings)).toBe(true);
  });
});
