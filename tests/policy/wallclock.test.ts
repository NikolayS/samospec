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
  BETWEEN_ROUND_BUDGET_MULTIPLIER,
  CAPPED_RETRY_MULTIPLIER,
  shouldStartNextRound,
  typicalRoundDurationMs,
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

// The raised SPEC §7 per-call timeout defaults (critique 900s, revise
// 1800s). These are what a default `samospec iterate` actually runs with
// and what previously collapsed the round budget through the gate.
const HIGH_TIMEOUTS = {
  criticA_ms: 900 * SECONDS,
  criticB_ms: 900 * SECONDS,
  revise_ms: 1800 * SECONDS,
};

// The default session budget (SPEC §11 / subscription-auth). After
// de-pessimizing the gate this is bumped (from the old 240) so a default
// session can start a healthy number of rounds at the raised SPEC §7
// per-call timeout defaults — wall-clock should not become the binding
// limit before DEFAULT_MAX_ROUNDS (10).
const DEFAULT_WALL_CLOCK_MIN = 600;

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

  test("less than one realistic round remaining -> false", () => {
    // Realistic round at DEFAULT_TIMEOUTS = (300 + 600) * 1.2 = 1080s = 18min.
    // Leave only 5min -> below the realistic-round estimate -> false.
    const state: WallclockState = {
      session_started_at_ms: 0,
      now_ms: 55 * 60 * 1000, // 5min remaining.
    };
    expect(shouldStartNextRound(state, budget)).toBe(false);
  });

  test("exactly one realistic round remaining -> true (boundary includes equal)", () => {
    const estimate = typicalRoundDurationMs(DEFAULT_TIMEOUTS);
    const state: WallclockState = {
      session_started_at_ms: 0,
      now_ms: budget.max_wall_clock_ms - estimate,
    };
    expect(shouldStartNextRound(state, budget)).toBe(true);
  });

  test("1 ms less than one realistic round remaining -> false", () => {
    const estimate = typicalRoundDurationMs(DEFAULT_TIMEOUTS);
    const state: WallclockState = {
      session_started_at_ms: 0,
      now_ms: budget.max_wall_clock_ms - estimate + 1,
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

  test("crafted small budget: realistic round fits but tight margin halts", () => {
    const smallBudget: WallclockBudget = {
      max_wall_clock_ms: 15 * 60 * 1000,
      call_timeouts_ms: {
        criticA_ms: 60_000,
        criticB_ms: 60_000,
        revise_ms: 60_000,
      },
    };
    // realistic round = (60 + 60) * 1.2 * 1000 = 144_000ms = 2.4min.
    const estimate = typicalRoundDurationMs(smallBudget.call_timeouts_ms);
    expect(estimate).toBe(144_000);
    const state: WallclockState = {
      session_started_at_ms: 0,
      now_ms: 0, // full 15min remaining, realistic round=2.4min -> true.
    };
    expect(shouldStartNextRound(state, smallBudget)).toBe(true);

    // Consume all but 1min; 1min remaining < 2.4min realistic round -> false.
    const state2: WallclockState = {
      session_started_at_ms: 0,
      now_ms: 14 * 60 * 1000,
    };
    expect(shouldStartNextRound(state2, smallBudget)).toBe(false);
  });
});

// ---------- between-round gate vs per-call worst case ----------

describe("typicalRoundDurationMs (between-round gate estimate)", () => {
  test("is a realistic round (one critique pass + one revise) without 3.5x retry inflation", () => {
    const t = {
      criticA_ms: 900_000,
      criticB_ms: 900_000,
      revise_ms: 1_800_000,
    };
    // (max(900, 900) + 1800) * BETWEEN_ROUND_BUDGET_MULTIPLIER seconds.
    const realisticBase =
      (900_000 + 1_800_000) * BETWEEN_ROUND_BUDGET_MULTIPLIER;
    expect(typicalRoundDurationMs(t)).toBe(realisticBase);
  });

  test("between-round multiplier is far smaller than the capped-retry multiplier", () => {
    // The whole point of FIX 1: the gate must NOT inflate by 3.5x.
    expect(BETWEEN_ROUND_BUDGET_MULTIPLIER).toBeLessThan(
      CAPPED_RETRY_MULTIPLIER,
    );
    expect(BETWEEN_ROUND_BUDGET_MULTIPLIER).toBeLessThanOrEqual(1.5);
  });

  test("typical round is much cheaper than the worst-case-with-retries round", () => {
    const t = HIGH_TIMEOUTS;
    expect(typicalRoundDurationMs(t)).toBeLessThan(worstCaseRoundDuration(t));
  });
});

// ---------- regression: default budget + high timeouts must not collapse ----------

describe("default budget + raised SPEC §7 timeouts (FIX 1 regression guard)", () => {
  const budget: WallclockBudget = {
    max_wall_clock_ms: DEFAULT_WALL_CLOCK_MIN * 60 * 1000,
    call_timeouts_ms: HIGH_TIMEOUTS,
  };

  // Simulate the loop: before each round check the gate, then advance
  // the clock by one realistic round. Returns how many rounds started.
  const countStartableRounds = (b: WallclockBudget): number => {
    const roundEstimate = typicalRoundDurationMs(HIGH_TIMEOUTS);
    let started = 0;
    for (let elapsed = 0; ; elapsed += roundEstimate) {
      const ok = shouldStartNextRound(
        { session_started_at_ms: 0, now_ms: elapsed },
        b,
      );
      if (!ok) break;
      started += 1;
      if (started > 100) break; // safety: never loop forever.
    }
    return started;
  };

  test("a fresh session can start at least 5 rounds at the default budget", () => {
    // Pre-fix: the 240-min default budget + the 3.5x worst-case gate
    // (≈157.5 min) collapsed this to ~2 rounds. FIX 1 (de-pessimized gate
    // + bumped default budget) must admit a healthy session.
    expect(countStartableRounds(budget)).toBeGreaterThanOrEqual(5);
  });

  test("gate de-pessimization alone: even the OLD 240-min budget admits >=4 rounds (not ~2)", () => {
    // This pins the GATE fix independent of the budget bump: at the
    // historical 240-min budget, the realistic-round gate admits ~4
    // rounds, whereas the old 3.5x worst-case gate admitted only ~2.
    // Reverting shouldStartNextRound to worstCaseRoundDuration makes
    // this fail (2 < 4), so a silent re-collapse is caught.
    const oldBudget: WallclockBudget = {
      max_wall_clock_ms: 240 * 60 * 1000,
      call_timeouts_ms: HIGH_TIMEOUTS,
    };
    expect(countStartableRounds(oldBudget)).toBeGreaterThanOrEqual(4);
  });

  test("still HALTS when remaining genuinely cannot fit one realistic round", () => {
    const roundEstimate = typicalRoundDurationMs(HIGH_TIMEOUTS);
    // Leave strictly less than one realistic round of wall-clock.
    const elapsed = budget.max_wall_clock_ms - roundEstimate + 1;
    expect(
      shouldStartNextRound(
        { session_started_at_ms: 0, now_ms: elapsed },
        budget,
      ),
    ).toBe(false);
  });

  test("exactly one realistic round remaining still starts (inclusive boundary)", () => {
    const roundEstimate = typicalRoundDurationMs(HIGH_TIMEOUTS);
    const elapsed = budget.max_wall_clock_ms - roundEstimate;
    expect(
      shouldStartNextRound(
        { session_started_at_ms: 0, now_ms: elapsed },
        budget,
      ),
    ).toBe(true);
  });
});
