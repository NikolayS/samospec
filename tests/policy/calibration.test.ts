// Copyright 2026 Nikolay Samokhvalov.

// SPEC §11 calibration storage: `.samo/config.json` gains a
// `calibration` object with `sample_count`, `tokens_per_round[]`,
// `rounds_to_converge[]`, `cost_per_run_usd[]`.
//
// Red-first contract:
//   1. `readCalibration(config)` returns a valid `Calibration` or null.
//   2. `recordSession(calibration, sample)` appends and caps at 20
//      (drops oldest).
//   3. `blendWeight(sample_count)` implements the SPEC §11 formula:
//      min(sample_count, 10) / 10.
//   4. `meanCalibrated(calibration)` averages the three arrays.
//   5. Invalid arrays parse as null (defensive: corrupted config is
//      treated as "no calibration", not as a crash).

import { describe, expect, test } from "bun:test";

import {
  blendWeight,
  CALIBRATION_CAP,
  CALIBRATION_FLOOR,
  meanCalibrated,
  readCalibration,
  recordSession,
  type Calibration,
  type CalibrationSample,
} from "../../src/policy/calibration.ts";

// ---------- readCalibration ----------

describe("readCalibration", () => {
  test("returns null when config.calibration is absent", () => {
    expect(readCalibration({})).toBeNull();
  });

  test("returns null when calibration is a non-object", () => {
    expect(readCalibration({ calibration: 123 })).toBeNull();
  });

  test("returns null on array/type mismatches", () => {
    expect(
      readCalibration({
        calibration: {
          sample_count: 0,
          tokens_per_round: "not-an-array",
          rounds_to_converge: [],
          cost_per_run_usd: [],
        },
      }),
    ).toBeNull();
  });

  test("returns a valid Calibration when well-formed", () => {
    const cal = readCalibration({
      calibration: {
        sample_count: 3,
        tokens_per_round: [100, 200, 300],
        rounds_to_converge: [5, 6, 7],
        cost_per_run_usd: [1, 2, 3],
      },
    });
    expect(cal).not.toBeNull();
    expect(cal?.sample_count).toBe(3);
    expect(cal?.tokens_per_round).toEqual([100, 200, 300]);
  });
});

// ---------- blendWeight ----------

describe("blendWeight (SPEC §11 formula)", () => {
  test("0 samples -> 0", () => {
    expect(blendWeight(0)).toBe(0);
  });

  test("below floor (1, 2) -> 0 (caller should not apply calibration)", () => {
    expect(blendWeight(1)).toBe(0);
    expect(blendWeight(2)).toBe(0);
  });

  test("exactly at floor (3) -> 0.3", () => {
    expect(blendWeight(3)).toBeCloseTo(0.3, 5);
  });

  test("7 samples -> 0.7", () => {
    expect(blendWeight(7)).toBeCloseTo(0.7, 5);
  });

  test("10 samples -> 1.0 (calibration dominates)", () => {
    expect(blendWeight(10)).toBe(1.0);
  });

  test("20 samples -> clamps to 1.0", () => {
    expect(blendWeight(20)).toBe(1.0);
  });

  test("100 samples -> 1.0", () => {
    expect(blendWeight(100)).toBe(1.0);
  });
});

// ---------- CALIBRATION_FLOOR / CAP constants ----------

describe("calibration constants", () => {
  test("floor is 3 per SPEC §11", () => {
    expect(CALIBRATION_FLOOR).toBe(3);
  });

  test("cap is 20 per SPEC §11", () => {
    expect(CALIBRATION_CAP).toBe(20);
  });
});

// ---------- meanCalibrated ----------

describe("meanCalibrated", () => {
  test("returns arithmetic mean of each array", () => {
    const cal: Calibration = {
      sample_count: 3,
      tokens_per_round: [100, 200, 300],
      rounds_to_converge: [2, 4, 6],
      cost_per_run_usd: [1, 2, 3],
    };
    const mean = meanCalibrated(cal);
    expect(mean.mean_tokens_per_round).toBe(200);
    expect(mean.mean_rounds_to_converge).toBe(4);
    expect(mean.mean_cost_per_run_usd).toBe(2);
  });

  test("empty arrays yield 0s (used when sample_count is 0)", () => {
    const cal: Calibration = {
      sample_count: 0,
      tokens_per_round: [],
      rounds_to_converge: [],
      cost_per_run_usd: [],
    };
    const mean = meanCalibrated(cal);
    expect(mean.mean_tokens_per_round).toBe(0);
    expect(mean.mean_rounds_to_converge).toBe(0);
    expect(mean.mean_cost_per_run_usd).toBe(0);
  });
});

// ---------- recordSession ----------

describe("recordSession", () => {
  const seed: Calibration = {
    sample_count: 0,
    tokens_per_round: [],
    rounds_to_converge: [],
    cost_per_run_usd: [],
  };

  test("appends a fresh sample to each array", () => {
    const sample: CalibrationSample = {
      session_actual_tokens: 150_000,
      session_actual_cost_usd: 3.25,
      session_rounds: 4,
    };
    const next = recordSession(seed, sample);
    expect(next.sample_count).toBe(1);
    expect(next.tokens_per_round).toEqual([150_000]);
    expect(next.rounds_to_converge).toEqual([4]);
    expect(next.cost_per_run_usd).toEqual([3.25]);
  });

  test("does not mutate the input (pure function)", () => {
    recordSession(seed, {
      session_actual_tokens: 1,
      session_actual_cost_usd: 1,
      session_rounds: 1,
    });
    expect(seed.sample_count).toBe(0);
    expect(seed.tokens_per_round).toEqual([]);
  });

  test("sample_count equals length of each array across N writes", () => {
    let cur = seed;
    for (let i = 1; i <= 5; i += 1) {
      cur = recordSession(cur, {
        session_actual_tokens: i * 100,
        session_actual_cost_usd: i,
        session_rounds: i,
      });
    }
    expect(cur.sample_count).toBe(5);
    expect(cur.tokens_per_round).toHaveLength(5);
    expect(cur.rounds_to_converge).toHaveLength(5);
    expect(cur.cost_per_run_usd).toHaveLength(5);
  });

  test("caps at 20 samples and drops the oldest", () => {
    let cur = seed;
    for (let i = 1; i <= 25; i += 1) {
      cur = recordSession(cur, {
        session_actual_tokens: i,
        session_actual_cost_usd: i,
        session_rounds: i,
      });
    }
    expect(cur.sample_count).toBe(20);
    expect(cur.tokens_per_round).toHaveLength(20);
    // Oldest dropped: first retained should be sample 6 (dropped 1..5).
    expect(cur.tokens_per_round[0]).toBe(6);
    expect(cur.tokens_per_round[19]).toBe(25);
    expect(cur.rounds_to_converge[0]).toBe(6);
    expect(cur.cost_per_run_usd[19]).toBe(25);
  });

  test("from a non-empty seed: trim drops oldest entries, not the new one", () => {
    // Pre-fill with 20 samples numbered 1..20.
    let cur: Calibration = {
      sample_count: 20,
      tokens_per_round: Array.from({ length: 20 }, (_v, i) => i + 1),
      rounds_to_converge: Array.from({ length: 20 }, (_v, i) => i + 1),
      cost_per_run_usd: Array.from({ length: 20 }, (_v, i) => i + 1),
    };
    cur = recordSession(cur, {
      session_actual_tokens: 99,
      session_actual_cost_usd: 99,
      session_rounds: 99,
    });
    expect(cur.sample_count).toBe(20);
    // Dropped the first (= 1), appended 99 at the tail.
    expect(cur.tokens_per_round[0]).toBe(2);
    expect(cur.tokens_per_round[19]).toBe(99);
  });
});
