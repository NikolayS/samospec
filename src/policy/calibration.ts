// Copyright 2026 Nikolay Samokhvalov.

// SPEC §11 calibration storage.
//
// `.samo/config.json` gains a `calibration` object:
//
//   {
//     "calibration": {
//       "sample_count": 0,
//       "tokens_per_round": [],
//       "rounds_to_converge": [],
//       "cost_per_run_usd": []
//     }
//   }
//
// This module exposes the typed read, the pure write helper
// (`recordSession`), and a file-level wrapper (`writeCalibrationSample`)
// that reads the repo's `config.json`, appends the sample, and
// atomically writes it back. Issue #15 calls the wrapper from the
// `samospec new` session-end hook.
//
// Blend-weight helper used by `preflight.ts`:
//
//   blendWeight = min(sample_count, 10) / 10
//
// Policy (SPEC §11):
//   - sample_count < 3  -> calibration is ignored (below floor)
//   - 3 <= count < 10   -> blended with defaults
//   - count >= 10       -> calibration dominates
//
// Arrays cap at 20; drop the oldest entry on overflow.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { z } from "zod";

// ---------- constants ----------

/** SPEC §11: preflight uses calibration only when sample_count >= floor. */
export const CALIBRATION_FLOOR = 3 as const;

/** SPEC §11: arrays are capped at this many samples; drop oldest. */
export const CALIBRATION_CAP = 20 as const;

/**
 * SPEC §11 blend formula hinge point: above this count the calibration
 * is treated as dominant and the weight caps at 1.0.
 */
const BLEND_SATURATION = 10 as const;

// ---------- zod schema ----------

export const CalibrationSchema = z
  .object({
    sample_count: z.number().int().nonnegative(),
    tokens_per_round: z.array(z.number()),
    rounds_to_converge: z.array(z.number()),
    cost_per_run_usd: z.array(z.number()),
  })
  .strict();

export type Calibration = z.infer<typeof CalibrationSchema>;

export interface CalibrationMeans {
  readonly mean_tokens_per_round: number;
  readonly mean_rounds_to_converge: number;
  readonly mean_cost_per_run_usd: number;
}

export interface CalibrationSample {
  readonly session_actual_tokens: number;
  readonly session_actual_cost_usd: number;
  readonly session_rounds: number;
}

// ---------- read ----------

/**
 * Read the `calibration` key off a loaded config object. Returns null
 * when absent or malformed — a corrupted config entry must not crash
 * preflight; we fall back to defaults.
 */
export function readCalibration(
  config: Readonly<Record<string, unknown>>,
): Calibration | null {
  const raw = config["calibration"];
  if (raw === undefined || raw === null) return null;
  const parsed = CalibrationSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data;
}

// ---------- blend weight ----------

/**
 * SPEC §11 formula. Below floor returns 0 (caller applies defaults).
 * At or above saturation returns 1 (calibration dominates).
 */
export function blendWeight(sampleCount: number): number {
  if (sampleCount < CALIBRATION_FLOOR) return 0;
  const clamped = Math.min(sampleCount, BLEND_SATURATION);
  return clamped / BLEND_SATURATION;
}

// ---------- means ----------

export function meanCalibrated(cal: Calibration): CalibrationMeans {
  return {
    mean_tokens_per_round: arithmeticMean(cal.tokens_per_round),
    mean_rounds_to_converge: arithmeticMean(cal.rounds_to_converge),
    mean_cost_per_run_usd: arithmeticMean(cal.cost_per_run_usd),
  };
}

function arithmeticMean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

// ---------- recordSession (pure; Issue #15 will wire this at session end) ----------

/**
 * Append a session's measured values to the calibration arrays.
 *
 * - Pure: does not mutate the input.
 * - Cap: if any array exceeds `CALIBRATION_CAP`, the *oldest* (front)
 *   entry is dropped.
 * - `sample_count` after the call equals the length of the three
 *   arrays (always kept in lockstep).
 */
export function recordSession(
  current: Calibration,
  sample: CalibrationSample,
): Calibration {
  const next: Calibration = {
    sample_count: 0, // set below
    tokens_per_round: append(
      current.tokens_per_round,
      sample.session_actual_tokens,
    ),
    rounds_to_converge: append(
      current.rounds_to_converge,
      sample.session_rounds,
    ),
    cost_per_run_usd: append(
      current.cost_per_run_usd,
      sample.session_actual_cost_usd,
    ),
  };
  // Keep the three arrays in lockstep length.
  // (All three appended exactly one entry; safety invariant below.)
  return { ...next, sample_count: next.tokens_per_round.length };
}

function append(xs: readonly number[], v: number): number[] {
  const out = xs.concat([v]);
  while (out.length > CALIBRATION_CAP) {
    out.shift();
  }
  return out;
}

// ---------- writeCalibrationSample (Issue #15 wiring) ----------

export interface WriteCalibrationSampleArgs {
  readonly cwd: string;
  /**
   * Rough token total for the session. For subscription-auth sessions
   * where the adapter could not report usage, callers still record the
   * estimated tokens so the array length matches the other arrays —
   * the cost array carries 0 in that case.
   */
  readonly session_actual_tokens: number;
  /**
   * Session cost in USD, or `null` when the adapter could not report
   * it (subscription auth). `null` is written as `0` so the three
   * calibration arrays stay the same length; preflight continues to
   * work with the imputed zero because the SPEC §11 blend formula
   * weights `mean_cost_per_run_usd` against per-vendor defaults.
   */
  readonly session_actual_cost_usd: number | null;
  /**
   * Review rounds that ran this session. Zero on the v0.1 draft
   * commit (no review loop has happened yet).
   */
  readonly session_rounds: number;
}

/**
 * Append a calibration sample to `.samo/config.json`. Reads the
 * existing config, parses the current calibration (or creates an empty
 * one), invokes `recordSession`, and atomically writes the new config.
 *
 * Errors (malformed config etc.) are thrown — the caller is expected
 * to log them without halting the session: session-end calibration
 * must never block a successful draft commit.
 */
export function writeCalibrationSample(
  args: WriteCalibrationSampleArgs,
): Calibration {
  const configPath = path.join(args.cwd, ".samo", "config.json");
  if (!existsSync(configPath)) {
    throw new Error(
      `writeCalibrationSample: .samo/config.json missing at ${configPath}`,
    );
  }
  const raw = readFileSync(configPath, "utf8");
  let parsed: Record<string, unknown>;
  try {
    const json: unknown = JSON.parse(raw);
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw new Error("config.json top-level must be a JSON object");
    }
    parsed = json as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `writeCalibrationSample: cannot parse config.json: ${
        (err as Error).message
      }`,
      { cause: err },
    );
  }

  const current: Calibration = readCalibration(parsed) ?? {
    sample_count: 0,
    tokens_per_round: [],
    rounds_to_converge: [],
    cost_per_run_usd: [],
  };

  // `null` cost becomes 0 in the array so lengths stay equal; preflight
  // applies the blend formula to the mean either way.
  const next = recordSession(current, {
    session_actual_tokens: args.session_actual_tokens,
    session_actual_cost_usd: args.session_actual_cost_usd ?? 0,
    session_rounds: args.session_rounds,
  });

  parsed["calibration"] = next;
  atomicWriteJson(configPath, parsed);

  return next;
}

function atomicWriteJson(
  file: string,
  value: Readonly<Record<string, unknown>>,
): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp.${process.pid}`);
  const payload = `${JSON.stringify(value, null, 2)}\n`;

  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, payload, 0, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }

  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Dir-fsync not supported on all platforms.
  }
}
