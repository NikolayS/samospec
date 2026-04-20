// Copyright 2026 Nikolay Samokhvalov.

// SPEC §11 wall-clock overrun rule.
//
// At each round boundary, compare remaining wall-clock against the
// worst-case duration of one more round. If `remaining < worst_case`,
// halt the loop with reason `wall-clock` (exit 4 per SPEC §10) rather
// than starting a round that will blow the budget during its retry
// tail.
//
// Worst-case per call (SPEC §7 capped retry):
//   base + 1.5 * base + base = 3.5 * base
//
// Reviewer pair is parallel (SPEC §7 "Reviewers in parallel"), so
// their worst case is dominated by `max(critiqueA, critiqueB)`.
// Revise is sequential after reviewers.
//
// This module is helper-only — no loop orchestration. Sprint 3
// Issue #15 wires it into the actual round boundary check.

/** SPEC §7: capped retry worst case `base + 1.5*base + base = 3.5*base`. */
export const CAPPED_RETRY_MULTIPLIER = 3.5 as const;

export interface CallTimeoutsMs {
  /** `critique` timeout for reviewer A (ms). SPEC §7 default 300s. */
  readonly criticA_ms: number;
  /** `critique` timeout for reviewer B (ms). */
  readonly criticB_ms: number;
  /** `revise` timeout for the lead (ms). SPEC §7 default 600s. */
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

/**
 * Worst-case duration of one more review round (SPEC §11):
 *
 *   reviewer_pair (parallel) -> dominated by max(a, b)
 *   + revise (sequential)
 *   each scaled by the 3.5x capped-retry multiplier.
 */
export function worstCaseRoundDuration(t: CallTimeoutsMs): number {
  const reviewerPairBase = Math.max(t.criticA_ms, t.criticB_ms);
  const roundBase = reviewerPairBase + t.revise_ms;
  return roundBase * CAPPED_RETRY_MULTIPLIER;
}

/**
 * Returns true when there is enough wall-clock remaining to safely run
 * one more worst-case round. Returns false at the boundary where
 * remaining < worst-case (the loop should halt with `wall-clock`).
 *
 * Equality: exactly matching remaining and worst-case is treated as
 * enough (inclusive boundary). The gate is `remaining < worst_case`.
 */
export function shouldStartNextRound(
  state: WallclockState,
  budget: WallclockBudget,
): boolean {
  const elapsed = Math.max(0, state.now_ms - state.session_started_at_ms);
  const remaining = budget.max_wall_clock_ms - elapsed;
  if (remaining <= 0) return false;
  const worst = worstCaseRoundDuration(budget.call_timeouts_ms);
  return remaining >= worst;
}
