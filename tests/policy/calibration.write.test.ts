// Copyright 2026 Nikolay Samokhvalov.

// SPEC §11 — file-level calibration write helper used by the
// samospec-new session-end hook (Issue #15).
//
// Contract:
//   - reads `.samospec/config.json` from `cwd`
//   - creates a fresh calibration object if none present
//   - appends via `recordSession` (cap 20, drop oldest)
//   - atomically writes the updated config (temp + fsync + rename)
//   - `null` cost is stored as 0 so the three arrays stay the same
//     length (preflight blends means with per-vendor defaults)
//   - throws when config.json is missing or malformed

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runInit } from "../../src/cli/init.ts";
import {
  writeCalibrationSample,
  readCalibration,
} from "../../src/policy/calibration.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-calibration-write-"));
  runInit({ cwd: tmp });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("writeCalibrationSample", () => {
  test("appends first sample with cost and writes config.json", () => {
    const next = writeCalibrationSample({
      cwd: tmp,
      session_actual_tokens: 100_000,
      session_actual_cost_usd: 1.23,
      session_rounds: 0,
    });
    expect(next.sample_count).toBe(1);
    expect(next.tokens_per_round).toEqual([100_000]);
    expect(next.cost_per_run_usd).toEqual([1.23]);
    expect(next.rounds_to_converge).toEqual([0]);

    // config.json on disk reflects the same shape.
    const raw = readFileSync(
      path.join(tmp, ".samospec", "config.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const readBack = readCalibration(parsed);
    expect(readBack).toEqual(next);
  });

  test("null cost is stored as 0 (arrays stay in lockstep)", () => {
    const next = writeCalibrationSample({
      cwd: tmp,
      session_actual_tokens: 80_000,
      session_actual_cost_usd: null,
      session_rounds: 0,
    });
    expect(next.sample_count).toBe(1);
    expect(next.cost_per_run_usd).toEqual([0]);
  });

  test("second call appends to prior calibration (cap not triggered)", () => {
    writeCalibrationSample({
      cwd: tmp,
      session_actual_tokens: 50_000,
      session_actual_cost_usd: 0.5,
      session_rounds: 0,
    });
    const next = writeCalibrationSample({
      cwd: tmp,
      session_actual_tokens: 60_000,
      session_actual_cost_usd: 0.6,
      session_rounds: 0,
    });
    expect(next.sample_count).toBe(2);
    expect(next.tokens_per_round).toEqual([50_000, 60_000]);
    expect(next.cost_per_run_usd).toEqual([0.5, 0.6]);
  });

  test("missing config.json throws a clear error", () => {
    const other = mkdtempSync(path.join(tmpdir(), "samospec-no-init-"));
    try {
      expect(() =>
        writeCalibrationSample({
          cwd: other,
          session_actual_tokens: 1,
          session_actual_cost_usd: 1,
          session_rounds: 0,
        }),
      ).toThrow(/config.json missing/i);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("malformed config.json throws (never silently overwrites)", () => {
    const p = path.join(tmp, ".samospec", "config.json");
    writeFileSync(p, "not valid json", "utf8");
    expect(() =>
      writeCalibrationSample({
        cwd: tmp,
        session_actual_tokens: 1,
        session_actual_cost_usd: 1,
        session_rounds: 0,
      }),
    ).toThrow(/config.json/i);
  });
});
