// Copyright 2026 Nikolay Samokhvalov.

// SPEC §5 Phase 1 + §11 preflight cost estimate.
//
// Runs at the END of Phase 1 — before persona, interview, context
// discovery (before any paid lead call). Inputs are scaffold-only:
//
//   - iteration cap `M` (config.budget.max_iterations)
//   - per-phase context budgets × phase count
//   - per-round token shares split between lead revision + reviewer pair
//   - calibration (if any) + per-vendor release-metadata coefficients
//
// Output: `PreflightEstimate` with:
//
//   - rangeLowUsd  — one-round scenario
//   - rangeHighUsd — M-round scenario
//   - likelyUsd    — P50 at M_likely, NOT arithmetic midpoint
//   - perAdapter   — { id: { tokens, usd | "unknown — OAuth
//                    (no per-token cost visibility)" } }
//   - warnings     — OAuth cap notices, usage-null, etc.
//   - belowFloor   — true when calibration sample_count < 3 (inline
//                    "first runs; estimate is approximate" printed)
//   - blendWeight  — 0 below floor; min(count, 10)/10 otherwise
//   - sampleCount  — calibration.sample_count if present, else 0
//
// The pretty-printer formats all this into the three-line `samospec`
// CLI summary. The consent gate reads `likelyUsd` to decide whether
// to prompt.

import {
  blendWeight,
  CALIBRATION_FLOOR,
  meanCalibrated,
  readCalibration,
  type Calibration,
} from "./calibration.ts";

// ---------- config surface ----------

export interface PreflightAdapterConfig {
  readonly adapter: string;
  readonly model_id: string;
  readonly effort: string;
  readonly fallback_chain: readonly string[];
}

export interface PreflightBudget {
  readonly max_iterations: number;
  readonly max_reviewers: number;
  readonly max_tokens_per_round: number;
  readonly max_total_tokens_per_session: number;
  readonly max_wall_clock_minutes: number;
  readonly preflight_confirm_usd: number;
}

export interface PreflightConfig {
  readonly adapters: {
    readonly lead: PreflightAdapterConfig;
    readonly reviewer_a: PreflightAdapterConfig;
    readonly reviewer_b: PreflightAdapterConfig;
  };
  readonly budget: PreflightBudget;
  readonly calibration: Calibration | null;
}

// ---------- adapter surface ----------

export interface PreflightAdapter {
  readonly id: string;
  readonly vendor: string;
  readonly role: "lead" | "reviewer_a" | "reviewer_b";
  readonly subscription_auth: boolean;
}

// ---------- result ----------

export interface PreflightPerAdapter {
  readonly tokens: number;
  readonly usd: number | "unknown — OAuth (no per-token cost visibility)";
}

export interface PreflightEstimate {
  readonly rangeLowUsd: number;
  readonly rangeHighUsd: number;
  readonly likelyUsd: number;
  readonly perAdapter: Readonly<Record<string, PreflightPerAdapter>>;
  readonly warnings: readonly string[];
  readonly belowFloor: boolean;
  readonly blendWeight: number;
  readonly sampleCount: number;
  readonly mLikely: number;
  readonly mMax: number;
}

// ---------- scaffold coefficients ----------
//
// SPEC §7 context budgets — fixed per-phase token costs used as
// "release-metadata coefficients" until the first three sessions
// have calibrated against real usage.
//
// Per-phase budgets: interview 5K, draft 30K, revision 20K.
// Context overhead (once, passed to lead at draft time): 55K total.

const CONTEXT_TOKENS_TOTAL = 5_000 + 30_000 + 20_000;
const DRAFT_TOKENS = 30_000; // one-shot v0.1 lead write
const REVISION_TOKENS_PER_ROUND = 20_000; // lead revision each round
const CRITIQUE_TOKENS_PER_ROUND = 15_000; // reviewer critique each round

// Per-vendor blended $/1M token coefficient. These are deliberate
// order-of-magnitude estimates — SPEC §11 calls them out as
// "approximate" until 3+ sessions have been calibrated against.
const VENDOR_USD_PER_M_TOKENS: Readonly<Record<string, number>> = {
  claude: 40,
  codex: 25,
};

const FALLBACK_VENDOR_USD_PER_M_TOKENS = 40;

function vendorUsdPerMTokens(vendor: string): number {
  return VENDOR_USD_PER_M_TOKENS[vendor] ?? FALLBACK_VENDOR_USD_PER_M_TOKENS;
}

// ---------- internal scaling ----------

interface CostScales {
  /** Fractional multiplier applied to per-round token figures. */
  readonly perRoundScale: number;
}

/**
 * When calibration is present and the blend weight > 0, mix the
 * calibrated per-round token observation with the default. The same
 * scale applies to every seat — the 50/70/100% blend in SPEC §11 is
 * about how much calibration data we trust, not about which seat it
 * came from.
 */
function computeScales(cal: Calibration | null, weight: number): CostScales {
  if (cal === null || weight === 0) return { perRoundScale: 1 };
  const means = meanCalibrated(cal);
  const defaultBase = REVISION_TOKENS_PER_ROUND + 2 * CRITIQUE_TOKENS_PER_ROUND;
  // Guard against meaningless calibration (0 mean) so we don't collapse.
  const calibratedBase =
    means.mean_tokens_per_round > 0 ? means.mean_tokens_per_round : defaultBase;
  const blended = weight * calibratedBase + (1 - weight) * defaultBase;
  return { perRoundScale: blended / defaultBase };
}

/** Tokens consumed by one adapter across `m` rounds under the scale. */
function tokensForAdapter(
  role: PreflightAdapter["role"],
  m: number,
  scale: CostScales,
): number {
  if (role === "lead") {
    const perRound = REVISION_TOKENS_PER_ROUND * scale.perRoundScale;
    return CONTEXT_TOKENS_TOTAL + DRAFT_TOKENS + m * perRound;
  }
  // reviewer_a / reviewer_b
  const perRound = CRITIQUE_TOKENS_PER_ROUND * scale.perRoundScale;
  return m * perRound;
}

function adapterUsd(tokens: number, vendor: string): number {
  const rate = vendorUsdPerMTokens(vendor);
  return (tokens / 1_000_000) * rate;
}

// ---------- public API ----------

export function computePreflight(
  config: PreflightConfig,
  adapters: readonly PreflightAdapter[],
): PreflightEstimate {
  const mMax = Math.max(1, config.budget.max_iterations);
  const cal = config.calibration;
  const sampleCount = cal?.sample_count ?? 0;
  const belowFloor = sampleCount < CALIBRATION_FLOOR;
  const weight = blendWeight(sampleCount);
  const scale = computeScales(cal, weight);
  const mLikely = computeMLikely(cal, weight, mMax);

  const perAdapter: Record<string, PreflightPerAdapter> = {};
  const warnings: string[] = [];

  let likelyTotalPriced = 0;
  let rangeLowTotalPriced = 0;
  let rangeHighTotalPriced = 0;
  let subscriptionAuthCount = 0;

  for (const ad of adapters) {
    // Tokens at M_likely used for per-adapter summary + total price.
    const tokensLikely = tokensForAdapter(ad.role, mLikely, scale);
    if (ad.subscription_auth) {
      perAdapter[ad.id] = {
        tokens: tokensLikely,
        usd: "unknown — OAuth (no per-token cost visibility)",
      };
      subscriptionAuthCount += 1;
      continue;
    }
    const usdLikely = adapterUsd(tokensLikely, ad.vendor);
    perAdapter[ad.id] = { tokens: tokensLikely, usd: usdLikely };

    const tokensLow = tokensForAdapter(ad.role, 1, scale);
    const tokensHigh = tokensForAdapter(ad.role, mMax, scale);
    likelyTotalPriced += usdLikely;
    rangeLowTotalPriced += adapterUsd(tokensLow, ad.vendor);
    rangeHighTotalPriced += adapterUsd(tokensHigh, ad.vendor);
  }

  if (subscriptionAuthCount > 0) {
    warnings.push(
      `${String(subscriptionAuthCount)} adapter(s) under OAuth; ` +
        `wall-clock + iteration caps substitute for token/cost budget`,
    );
  }

  return {
    rangeLowUsd: rangeLowTotalPriced,
    rangeHighUsd: rangeHighTotalPriced,
    likelyUsd: likelyTotalPriced,
    perAdapter,
    warnings,
    belowFloor,
    blendWeight: weight,
    sampleCount,
    mLikely,
    mMax,
  };
}

/**
 * `M_likely` is `mean_rounds_to_converge` when above the calibration
 * floor (blended with the default `M/2` by `weight`); below the floor
 * it is simply `M/2`. SPEC §11.
 */
function computeMLikely(
  cal: Calibration | null,
  weight: number,
  mMax: number,
): number {
  const defaultM = mMax / 2;
  if (cal === null || weight === 0) return defaultM;
  const means = meanCalibrated(cal);
  if (means.mean_rounds_to_converge <= 0) return defaultM;
  return weight * means.mean_rounds_to_converge + (1 - weight) * defaultM;
}

// ---------- load from parsed config ----------

/**
 * Convenience: build a `PreflightConfig` from an already-parsed JSON
 * config object (i.e. the contents of `.samo/config.json`). Missing
 * keys throw — callers should ensure `runInit` has been run.
 */
export function preflightConfigFromParsed(
  raw: Readonly<Record<string, unknown>>,
): PreflightConfig {
  const adapters = raw["adapters"] as PreflightConfig["adapters"] | undefined;
  const budget = raw["budget"] as PreflightBudget | undefined;
  if (!adapters || !budget) {
    throw new Error(
      "preflight config must have adapters + budget; run samospec init first",
    );
  }
  return {
    adapters,
    budget,
    calibration: readCalibration(raw),
  };
}

// ---------- pretty-printer ----------

export function formatPreflight(e: PreflightEstimate): string {
  const lines: string[] = [];
  const headline = `estimated range: $${formatUsd(e.rangeLowUsd)}–$${formatUsd(
    e.rangeHighUsd,
  )}, likely $${formatUsd(e.likelyUsd)}`;
  const tail = e.belowFloor ? " (first runs; estimate is approximate)" : "";
  lines.push(headline + tail);

  lines.push("per-adapter:");
  for (const [id, entry] of Object.entries(e.perAdapter)) {
    const price =
      typeof entry.usd === "number" ? `$${formatUsd(entry.usd)}` : entry.usd;
    lines.push(`  ${id}: ~${formatTokens(entry.tokens)} tokens, ${price}`);
  }

  if (e.warnings.length > 0) {
    lines.push("warnings:");
    for (const w of e.warnings) lines.push(`  ${w}`);
  }

  return lines.join("\n");
}

function formatUsd(v: number): string {
  // 2 decimal places; no thousands separator for CLI brevity.
  return v.toFixed(2);
}

function formatTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}K`;
  return String(Math.round(v));
}
