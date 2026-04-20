// Copyright 2026 Nikolay Samokhvalov.

/**
 * Doctor check — calibration state.
 *
 * SPEC §11: preflight estimate accuracy improves as `samospec` runs more
 * sessions in a repo. This check reads the `calibration` block from
 * `.samo/config.json` and reports the current sample count and floor
 * status so users understand estimate reliability:
 *
 *   < 3 samples  → "first runs; estimate is approximate"
 *   3-10 samples → "blended (calibration + defaults weighted)"
 *   > 10 samples → "dominated by calibration data"
 *
 * Status:
 *   - OK    — sample_count >= 3 (calibration active).
 *   - WARN  — sample_count < 3 (below floor; estimate is approximate).
 *   - FAIL  — config.json missing or calibration block absent/malformed.
 *             (Soft fail — config check also covers the missing-file case.)
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { CheckStatus, type CheckResult } from "../doctor-format.ts";
import { CALIBRATION_FLOOR, readCalibration } from "../../policy/calibration.ts";

export interface CalibrationCheckArgs {
  /** Absolute path to `.samo/config.json`. */
  readonly configPath: string;
}

function floorLabel(sampleCount: number): string {
  if (sampleCount < CALIBRATION_FLOOR) {
    return "first runs; estimate is approximate";
  }
  if (sampleCount <= 10) {
    return "blended (calibration + defaults weighted)";
  }
  return "dominated by calibration data";
}

export function checkCalibration(args: CalibrationCheckArgs): CheckResult {
  if (!existsSync(args.configPath)) {
    return {
      status: CheckStatus.Warn,
      label: "calibration",
      message: "config.json not found — run `samospec init` first",
    };
  }

  let raw: string;
  try {
    raw = readFileSync(args.configPath, "utf8");
  } catch (err) {
    return {
      status: CheckStatus.Warn,
      label: "calibration",
      message: `cannot read config.json: ${(err as Error).message}`,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    const json: unknown = JSON.parse(raw);
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw new Error("top-level must be a JSON object");
    }
    parsed = json as Record<string, unknown>;
  } catch (err) {
    return {
      status: CheckStatus.Warn,
      label: "calibration",
      message: `config.json malformed: ${(err as Error).message}`,
    };
  }

  const cal = readCalibration(parsed);
  if (cal === null) {
    return {
      status: CheckStatus.Warn,
      label: "calibration",
      message:
        "no calibration data yet (sample_count: 0) — " +
        "first runs; estimate is approximate",
    };
  }

  const count = cal.sample_count;
  const label = floorLabel(count);
  const status = count < CALIBRATION_FLOOR ? CheckStatus.Warn : CheckStatus.Ok;

  return {
    status,
    label: "calibration",
    message: `sample_count: ${String(count)} — ${label}`,
  };
}
