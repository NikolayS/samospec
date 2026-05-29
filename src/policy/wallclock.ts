// Copyright 2026 Nikolay Samokhvalov.

// SPEC §11 wall-clock overrun rule.
//
// At each round boundary, compare remaining wall-clock against the
// estimated duration of one more round. If `remaining < estimate`,
// halt the loop with reason `wall-clock` (exit 4 per SPEC §10) rather
// than starting a round that genuinely cannot finish in the budget.
//
// TWO distinct estimates live here, for two distinct jobs:
//
//   1. Worst-case-with-retries (CAPPED_RETRY_MULTIPLIER = 3.5x) — the
//      true ceiling of a single adapter call when every retry tier
//      fires (base + 1.5*base + base). This is the right number for the
//      per-CALL timeout cap.
//
//   2. Typical round (BETWEEN_ROUND_BUDGET_MULTIPLIER ≈ 1.2x) — a
//      realistic round (one critique pass + one revise) WITHOUT the
//      pessimistic retry inflation. This is the right number for the
//      BETWEEN-ROUND budget gate: applying the 3.5x ceiling there
//      assumes every round hits its full retry tail, which collapses a
//      default `samospec iterate` to ~1-2 rounds even though typical
//      rounds finish well under the per-call cap (samospec #180 FIX 1).
//
// Reviewer pair is parallel (SPEC §7 "Reviewers in parallel"), so
// their cost is dominated by `max(critiqueA, critiqueB)`. Revise is
// sequential after reviewers.
//
// This module is helper-only — no loop orchestration.

/** SPEC §7: capped retry worst case `base + 1.5*base + base = 3.5*base`. */
export const CAPPED_RETRY_MULTIPLIER = 3.5 as const;

/**
 * Safety factor applied to a realistic round duration for the
 * BETWEEN-ROUND budget gate. A round normally needs one critique pass
 * plus one revise; the small headroom (~20%) absorbs occasional single
 * retries and overhead WITHOUT assuming every call exhausts its full
 * 3.5x retry tail. Deliberately far below {@link CAPPED_RETRY_MULTIPLIER}
 * so the gate does not refuse rounds a healthy session can actually run
 * (samospec #180 FIX 1).
 */
export const BETWEEN_ROUND_BUDGET_MULTIPLIER = 1.2 as const;

export interface CallTimeoutsMs {
  /** `critique` timeout for reviewer A (ms). SPEC §7 default 900s. */
  readonly criticA_ms: number;
  /** `critique` timeout for reviewer B (ms). */
  readonly criticB_ms: number;
  /** `revise` timeout for the lead (ms). SPEC §7 default 1800s. */
  readonly revise_ms: number;
}

export interface WallclockBudget {
  /** `budget.max_wall_clock_minutes` expressed as ms. */
  readonly max_wall_clock_ms: number;
  readonly call_timeouts_ms: CallTimeoutsMs;
}

export interface WallclockState {
  readonly session_started_at_ms: number;
  readonly now_ms: number;
}

/** Worst-case duration of a single adapter call under capped retry. */
export function worstCaseCallDurationMs(baseTimeoutMs: number): number {
  return baseTimeoutMs * CAPPED_RETRY_MULTIPLIER;
}

/** Base cost of one round: parallel reviewers (max) + sequential revise. */
function roundBaseMs(t: CallTimeoutsMs): number {
  const reviewerPairBase = Math.max(t.criticA_ms, t.criticB_ms);
  return reviewerPairBase + t.revise_ms;
}

/**
 * Worst-case duration of one more review round under capped retry
 * (SPEC §11): the round base scaled by the 3.5x capped-retry multiplier
 * (every call hits its full retry tail). Used for the per-call timeout
 * cap and surfaced in `samospec status` as the ceiling — NOT used as the
 * between-round gate (see {@link typicalRoundDurationMs}).
 *
 *   reviewer_pair (parallel) -> dominated by max(a, b)
 *   + revise (sequential)
 *   each scaled by the 3.5x capped-retry multiplier.
 */
export function worstCaseRoundDuration(t: CallTimeoutsMs): number {
  return roundBaseMs(t) * CAPPED_RETRY_MULTIPLIER;
}

/**
 * Realistic duration of one more review round for the BETWEEN-ROUND
 * budget gate: one critique pass + one revise, scaled only by the small
 * {@link BETWEEN_ROUND_BUDGET_MULTIPLIER} safety factor (NOT the 3.5x
 * retry ceiling). This is what {@link shouldStartNextRound} compares
 * against so a default session can start a healthy number of rounds
 * instead of collapsing after ~2 (samospec #180 FIX 1).
 */
export function typicalRoundDurationMs(t: CallTimeoutsMs): number {
  return roundBaseMs(t) * BETWEEN_ROUND_BUDGET_MULTIPLIER;
}

/**
 * Returns true when there is enough wall-clock remaining to run one more
 * REALISTIC round (one critique pass + one revise, with a small safety
 * factor). Returns false at the boundary where remaining < that estimate
 * (the loop should halt with `wall-clock`).
 *
 * The gate intentionally uses {@link typicalRoundDurationMs}, not the
 * 3.5x worst-case-with-retries duration: gating on the retry ceiling
 * wrongly assumes every round exhausts every retry tier and collapsed a
 * default session to ~2 rounds (samospec #180 FIX 1). It still correctly
 * refuses to START a round that a realistic run cannot finish.
 *
 * Equality: exactly matching remaining and estimate is treated as enough
 * (inclusive boundary). The gate is `remaining < estimate`.
 */
export function shouldStartNextRound(
  state: WallclockState,
  budget: WallclockBudget,
): boolean {
  const elapsed = Math.max(0, state.now_ms - state.session_started_at_ms);
  const remaining = budget.max_wall_clock_ms - elapsed;
  if (remaining <= 0) return false;
  const estimate = typicalRoundDurationMs(budget.call_timeouts_ms);
  return remaining >= estimate;
}
