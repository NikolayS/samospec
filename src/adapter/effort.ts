// Copyright 2026 Nikolay Samokhvalov.

// Unified effort resolution (samospec robustness pass).
//
// Effort (the reasoning depth/speed knob) reaches every seat — lead,
// reviewer_a, reviewer_b — through a single, documented precedence:
//
//   1. The global `--effort <level>` CLI flag, when supplied. It
//      OVERRIDES every seat uniformly and wins over per-seat config.
//   2. The per-seat `adapters.<seat>.effort` in `.samo/config.json`,
//      when present for that seat.
//   3. The unified default {@link UNIFIED_DEFAULT_EFFORT} — `"medium"`
//      (a balanced average), NOT `"max"`.
//
// Before this module every lead call defaulted to `"max"` (scattered
// `input.effort ?? "max"` fallbacks + hardcoded `effort: "max"` in the
// round runner). That made runs slow by default and gave the user no
// single knob to dial depth vs speed for all seats at once. This module
// centralises the resolution so the default is consistent (medium) and
// the `--effort` flag is honoured everywhere.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { EffortLevelSchema, type EffortLevel } from "./types.ts";

/**
 * The unified effort default applied to every seat when neither the
 * `--effort` flag nor a per-seat config value pins it. A balanced
 * average — deliberately NOT `"max"` so the out-of-the-box experience
 * trades a little depth for a lot of speed.
 */
export const UNIFIED_DEFAULT_EFFORT: EffortLevel = "medium";

/** The seats whose effort can be resolved/overridden. */
export type SeatKey = "lead" | "reviewer_a" | "reviewer_b";

export const SEAT_KEYS: readonly SeatKey[] = [
  "lead",
  "reviewer_a",
  "reviewer_b",
];

/** Resolved effort for all three seats. */
export interface SeatEfforts {
  readonly lead: EffortLevel;
  readonly reviewer_a: EffortLevel;
  readonly reviewer_b: EffortLevel;
}

/**
 * Result of parsing the `--effort <level>` flag value. On success,
 * `value` is the validated {@link EffortLevel}. On failure, `error`
 * carries a clear usage message naming the valid set.
 */
export type ParseEffortResult =
  | { readonly ok: true; readonly value: EffortLevel }
  | { readonly ok: false; readonly error: string };

/**
 * The canonical ladder, ordered deepest→fastest, used in the usage
 * message and the interactive prompt so users always see the same set.
 */
export const EFFORT_LADDER: readonly EffortLevel[] = [
  "max",
  "high",
  "medium",
  "low",
  "off",
];

/**
 * Parse + validate a `--effort` flag value against the EffortLevel enum.
 * Empty / unknown values are rejected with a message that names the
 * valid token set, so callers can surface it above USAGE and exit 2.
 */
export function parseEffortFlag(raw: string): ParseEffortResult {
  const trimmed = raw.trim();
  const parsed = EffortLevelSchema.safeParse(trimmed);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return {
    ok: false,
    error:
      `--effort must be one of ${EFFORT_LADDER.join("|")} ` + `(got '${raw}')`,
  };
}

/**
 * Resolve the effective effort for ONE seat following the documented
 * precedence: flag > per-seat config > unified medium default.
 */
export function resolveSeatEffort(
  flagEffort: EffortLevel | undefined,
  configEffort: EffortLevel | undefined,
): EffortLevel {
  if (flagEffort !== undefined) return flagEffort;
  if (configEffort !== undefined) return configEffort;
  return UNIFIED_DEFAULT_EFFORT;
}

/**
 * Read the per-seat `adapters.<seat>.effort` values from
 * `.samo/config.json` under `cwd`. Best-effort: any missing file /
 * parse error / wrong shape yields `{}` so callers fall back to the
 * unified default. Only valid {@link EffortLevel} strings are kept;
 * anything else for a seat is ignored (treated as unset).
 */
export function readSeatEfforts(
  cwd: string,
): Partial<Record<SeatKey, EffortLevel>> {
  try {
    const configPath = path.join(cwd, ".samo", "config.json");
    if (!existsSync(configPath)) return {};
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const adapters = (parsed as Record<string, unknown>)["adapters"];
    if (typeof adapters !== "object" || adapters === null) return {};
    const rec = adapters as Record<string, unknown>;
    const out: Partial<Record<SeatKey, EffortLevel>> = {};
    for (const seat of SEAT_KEYS) {
      const raw = rec[seat];
      if (typeof raw !== "object" || raw === null) continue;
      const effortRaw = (raw as Record<string, unknown>)["effort"];
      if (typeof effortRaw !== "string") continue;
      const validated = EffortLevelSchema.safeParse(effortRaw);
      if (validated.success) out[seat] = validated.data;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolve the effective effort for every seat at once. The `--effort`
 * flag, when supplied, OVERRIDES all three seats uniformly; otherwise
 * each seat falls back to its own `adapters.<seat>.effort` config value
 * and finally to the unified medium default.
 */
export function resolveAllSeatEfforts(input: {
  readonly cwd: string;
  readonly flagEffort?: EffortLevel;
}): SeatEfforts {
  const config = readSeatEfforts(input.cwd);
  return {
    lead: resolveSeatEffort(input.flagEffort, config.lead),
    reviewer_a: resolveSeatEffort(input.flagEffort, config.reviewer_a),
    reviewer_b: resolveSeatEffort(input.flagEffort, config.reviewer_b),
  };
}

/**
 * Returns true when effort is "pinned" — i.e. the user has already
 * expressed a choice via the `--effort` flag OR via a per-seat config
 * value. Used by the interactive prompt gate: when effort is pinned we
 * do NOT prompt (the choice is already made). When nothing is pinned,
 * a TTY run prompts the user once at startup.
 */
export function effortIsPinned(input: {
  readonly cwd: string;
  readonly flagEffort?: EffortLevel;
}): boolean {
  if (input.flagEffort !== undefined) return true;
  const config = readSeatEfforts(input.cwd);
  return SEAT_KEYS.some((seat) => config[seat] !== undefined);
}

/**
 * The interactive effort prompt copy. Concise tradeoff explanation with
 * a rough per-level ETA and an explicit caveat that the ETAs are rough
 * and scale with spec size + provider speed. Followed by the choose
 * line. Exported so the CLI prompt and tests compare against one
 * canonical string. `\n`-terminated lines; the caller appends the
 * readline answer inline after the final colon.
 */
export const EFFORT_PROMPT_INTRO =
  "Reasoning effort — depth vs speed " +
  "(ETAs are rough; scale with spec size + provider speed):\n" +
  "  max    — deepest review;     ~20-40 min/round\n" +
  "  high   — deep;               ~15-30 min/round\n" +
  "  medium — balanced (default); ~5-12 min/round\n" +
  "  low    — shallow, fast;      ~2-5 min/round\n" +
  "  off    — minimal;            ~1-2 min/round\n";

/** The trailing choose line (with default). */
export const EFFORT_PROMPT_CHOOSE =
  "Choose [max/high/medium/low/off] (default medium): ";

/**
 * Resolve the answer to the interactive effort prompt. Empty input
 * (just Enter) selects the unified medium default. An unrecognised
 * value also falls back to the default rather than erroring — the
 * prompt is a convenience, not a gate; users who want strict validation
 * pass `--effort`.
 */
export function resolvePromptedEffort(raw: string): EffortLevel {
  const parsed = parseEffortFlag(raw);
  return parsed.ok ? parsed.value : UNIFIED_DEFAULT_EFFORT;
}
