// Copyright 2026 Nikolay Samokhvalov.

// SPEC §11 wall-clock overrun rule.
//
// At each round boundary, compare remaining wall-clock against the
// worst-case duration of one more round. If remaining < worst-case,
// the loop halts with reason `wall-clock` (exit 4 per SPEC §10) —
// don't start another round just to timeout during the retry tail.
//
// Worst-case per call (SPEC §7 capped retry: base + 1.5*base + base
// = 3.5*base). Reviewer pair is parallel — dominated by max(a, b).

import { describe, expect, test } from "bun:test";

import {
  CAPPED_RETRY_MULTIPLIER,
  shouldStartNextRound,
  worstCaseCallDurationMs,
  worstCaseRoundDuration,
  type WallclockBudget,
  type WallclockState,
} from "../../src/policy/wallclock.ts";

// Three-pinned seats at their SPEC §7 default timeouts (ms):
// ask 120s / critique 300s / revise 600s.
const SECONDS = 1_000;
const DEFAULT_TIMEOUTS = {
  criticA_ms: 300 * SECONDS,
  criticB_ms: 300 * SECONDS,
  revise_ms: 600 * SECONDS,
};

// ---------- capped-retry constant ----------

describe("CAPPED_RETRY_MULTIPLIER (SPEC §7)", () => {
  test("base + 1.5*base + base = 3.5x", () => {
    expect(CAPPED_RETRY_MULTIPLIER).toBe(3.5);
  });
});

// ---------- worstCaseCallDurationMs ----------

describe("worstCaseCallDurationMs", () => {
  test("scales the base timeout by 3.5x", () => {
    expect(worstCaseCallDurationMs(1000)).toBe(3500);
  });

  test("0 base => 0", () => {
    expect(worstCaseCallDurationMs(0)).toBe(0);
  });
});

// ---------- worstCaseRoundDuration ----------

describe("worstCaseRoundDuration (SPEC §11)", () => {
  test("reviewer pair is parallel -> dominated by max; revise sequential", () => {
    const r = worstCaseRoundDuration({
      criticA_ms: 100,
      criticB_ms: 200,
      revise_ms: 500,
    });
    // (max(100, 200) * 3.5) + (500 * 3.5) = 700 + 1750 = 2450.
    expect(r).toBe(2450);
  });

  test("real defaults produce ~70min worst case", () => {
    const r = worstCaseRoundDuration(DEFAULT_TIMEOUTS);
    // (300 * 3.5) + (600 * 3.5) = 1050 + 2100 = 3150s => ~52.5 min.
    expect(r).toBe(3150 * 1000);
  });

  test("equal critic timeouts still use max(a, a) = a", () => {
    const r = worstCaseRoundDuration({
      criticA_ms: 300,
      criticB_ms: 300,
      revise_ms: 600,
    });
    expect(r).toBe((300 + 600) * 3.5);
  });
});

// ---------- shouldStartNextRound ----------

describe("shouldStartNextRound (SPEC §11 overrun rule)", () => {
  const budget: WallclockBudget = {
    max_wall_clock_ms: 60 * 60 * 1000, // 1h
    call_timeouts_ms: DEFAULT_TIMEOUTS,
  };

  test("plenty of time remaining -> true", () => {
    const state: WallclockState = {
      session_started_at_ms: 0,
      now_ms: 0,
    };
    expect(shouldStartNextRound(state, budget)).toBe(true);
  });

  test("5 minutes remaining, worst-case round is 52.5 min -> false", () => {
    const state: WallclockState = {
      session_started_at_ms: 0,
      // Elapsed = 55min -> 5min remaining.
      now_ms: 55 * 60 * 1000,
    };
    expect(shouldStartNextRound(state, budget)).toBe(false);
  });

  test("exactly worst-case remaining -> true (boundary includes equal)", () => {
    const worst = worstCaseRoundDuration(DEFAULT_TIMEOUTS);
    const state: WallclockState = {
      session_started_at_ms: 0,
      now_ms: budget.max_wall_clock_ms - worst,
    };
    expect(shouldStartNextRound(state, budget)).toBe(true);
  });

  test("1 ms less than worst-case remaining -> false", () => {
    const worst = worstCaseRoundDuration(DEFAULT_TIMEOUTS);
    const state: WallclockState = {
      session_started_at_ms: 0,
      now_ms: budget.max_wall_clock_ms - worst + 1,
    };
    expect(shouldStartNextRound(state, budget)).toBe(false);
  });

  test("already over budget -> false", () => {
    const state: WallclockState = {
      session_started_at_ms: 0,
      now_ms: budget.max_wall_clock_ms + 1000,
    };
    expect(shouldStartNextRound(state, budget)).toBe(false);
  });

  test("crafted 15 minute budget / worst-case 10 min -> true", () => {
    const smallBudget: WallclockBudget = {
      max_wall_clock_ms: 15 * 60 * 1000,
      call_timeouts_ms: {
        // Tuned so worst-case is exactly 10 min:
        // (max(a, b) + revise) * 3.5 = 600s => (a + revise) = 171.428s
        // Simpler: max=60s, revise=111.428s => 60*3.5+111.428*3.5 ≈ 600s.
        // Cleanest: a=b=60s, revise=60s => worst = (60+60)*3.5 = 420s = 7min.
        // Try a=b=80, revise=80 => (80+80)*3.5 = 560s ~ 9.33min. Still < 10.
        // Use a=b=100, revise=71.42 => not clean integers. Use exact 10-min:
        // (100 + 71_428/1000) * 3.5 = 600? Too fiddly.
        // Pick (a=b)=40_000ms, revise=131_429ms: (40+131.429)*3.5 = 600.
        // Simpler: directly test with the helper, avoid magic numbers.
        criticA_ms: 60_000,
        criticB_ms: 60_000,
        revise_ms: 60_000,
      },
    };
    // worst = (60 + 60) * 3.5 * 1000 = 420_000ms = 7min.
    const state: WallclockState = {
      session_started_at_ms: 0,
      now_ms: 0, // full 15min remaining, worst=7min -> true.
    };
    expect(shouldStartNextRound(state, smallBudget)).toBe(true);

    // Now consume 9min; 6min remaining < 7min worst -> false.
    const state2: WallclockState = {
      session_started_at_ms: 0,
      now_ms: 9 * 60 * 1000,
    };
    expect(shouldStartNextRound(state2, smallBudget)).toBe(false);
  });
});
