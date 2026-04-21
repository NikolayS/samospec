// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §12 — all eight stopping conditions.
 *
 * Only the detectors live here. Acting on a stop (writing state.json,
 * exit codes, halting the loop) is the caller's job (round.ts / iterate).
 *
 * Conditions (priority order in classifyAllStops):
 *   1. Max rounds reached (budget.max_iterations default 10).
 *   2. Reviewer availability zero (both seats exhausted + user decline).
 *      Checked BEFORE ready/convergence (#64): when no reviewer produced
 *      output, the lead's ready signal must be suppressed.
 *   3. Lead ready=true (structured signal).
 *   4. Semantic convergence: two consecutive low-delta rounds with
 *      diff ≤ convergence.min_delta_lines (default 20) AND no new
 *      findings in non-summary categories for either round.
 *   5. Repeat-findings halt: ≥5 findings AND ≥80% of findings have a
 *      trigram-Jaccard (normalized, same-category) match against the
 *      prior round ≥ 0.8 — reason "lead-ignoring-critiques".
 *   6. User SIGINT.
 *   7. Budget hit (tokens / cost / wall-clock).
 *   8. lead_terminal state reachable from any round.
 *
 * The "two consecutive low-delta rounds without full convergence" case
 * emits a print-only `suggestDownshift: true` hint — it does not halt.
 * Caller prints the hint.
 */

import type { Finding, FindingCategory } from "../adapter/types.ts";
import { jaccardSimilarity, normalizeForRepeatDetection } from "./trigram.ts";

// ---------- constants ----------

/** SPEC §12 condition 4 trigram-Jaccard threshold. */
export const REPEAT_JACCARD_THRESHOLD = 0.8 as const;
/** SPEC §12 condition 4 ratio threshold. */
export const REPEAT_RATIO_THRESHOLD = 0.8 as const;
/** SPEC §12 condition 4 minimum-findings floor. */
export const MIN_FINDINGS_FLOOR = 5 as const;
/** SPEC §12 condition 3 default diff cutoff (convergence.min_delta_lines). */
export const CONVERGENCE_DEFAULT_DELTA = 20 as const;

// ---------- repeat-findings halt ----------

export interface RepeatFindingsInput {
  readonly current: readonly Finding[];
  readonly previous: readonly Finding[];
  /** Optional override for the Jaccard threshold (tests may tweak). */
  readonly jaccardThreshold?: number;
  /** Optional override for the ratio threshold. */
  readonly ratioThreshold?: number;
  /** Optional override for the minimum-findings floor. */
  readonly minFindingsFloor?: number;
}

export type RepeatFindingsReason =
  | "lead-ignoring-critiques"
  | "floor_not_met"
  | "below_ratio"
  | "no_previous_findings";

export interface RepeatFindingsOutcome {
  readonly halt: boolean;
  readonly reason: RepeatFindingsReason;
  readonly repeatedCount: number;
  readonly totalCount: number;
  /** Max trigram-Jaccard similarity seen per current finding. */
  readonly similarities: readonly number[];
}

/**
 * Implement SPEC §12 condition 4.
 *
 * Steps:
 *  1. Floor: `current.length < minFindingsFloor` → `halt=false,
 *     reason="floor_not_met"`.
 *  2. For each current finding: look up every previous finding in the
 *     SAME category, normalize both texts, compute trigram Jaccard.
 *     Keep the max.
 *  3. Repeated if max ≥ `jaccardThreshold`.
 *  4. If `repeatedCount / totalCount ≥ ratioThreshold`: halt with
 *     `reason="lead-ignoring-critiques"`; else `reason="below_ratio"`.
 */
export function checkRepeatFindings(
  input: RepeatFindingsInput,
): RepeatFindingsOutcome {
  const jaccard = input.jaccardThreshold ?? REPEAT_JACCARD_THRESHOLD;
  const ratio = input.ratioThreshold ?? REPEAT_RATIO_THRESHOLD;
  const floor = input.minFindingsFloor ?? MIN_FINDINGS_FLOOR;

  const total = input.current.length;
  if (total < floor) {
    return {
      halt: false,
      reason: "floor_not_met",
      repeatedCount: 0,
      totalCount: total,
      similarities: [],
    };
  }

  // Bucket previous findings by category, normalized once up front.
  const byCategory = new Map<FindingCategory, string[]>();
  for (const p of input.previous) {
    const norm = normalizeForRepeatDetection(p.text);
    const bucket = byCategory.get(p.category);
    if (bucket === undefined) {
      byCategory.set(p.category, [norm]);
    } else {
      bucket.push(norm);
    }
  }

  if (byCategory.size === 0) {
    return {
      halt: false,
      reason: "no_previous_findings",
      repeatedCount: 0,
      totalCount: total,
      similarities: new Array<number>(total).fill(0),
    };
  }

  const sims: number[] = [];
  let repeated = 0;
  for (const f of input.current) {
    const norm = normalizeForRepeatDetection(f.text);
    const bucket = byCategory.get(f.category) ?? [];
    let maxSim = 0;
    for (const prev of bucket) {
      const s = jaccardSimilarity(norm, prev);
      if (s > maxSim) maxSim = s;
    }
    sims.push(maxSim);
    if (maxSim >= jaccard) repeated += 1;
  }

  const repeatRatio = repeated / total;
  if (repeatRatio >= ratio) {
    return {
      halt: true,
      reason: "lead-ignoring-critiques",
      repeatedCount: repeated,
      totalCount: total,
      similarities: sims,
    };
  }
  return {
    halt: false,
    reason: "below_ratio",
    repeatedCount: repeated,
    totalCount: total,
    similarities: sims,
  };
}

// ---------- semantic convergence ----------

export interface RoundSignals {
  readonly findings: readonly Finding[];
  /** Lines changed between the previous committed SPEC.md and this one. */
  readonly diffLines: number;
  /** Number of categories OTHER than `summary` that received findings. */
  readonly nonSummaryCategoriesWithFindings: number;
}

export type PreviousRoundSignals = RoundSignals;

export interface ConvergenceInput {
  readonly current: RoundSignals;
  readonly previous: PreviousRoundSignals;
  readonly minDeltaLines?: number;
}

export interface ConvergenceOutcome {
  readonly converged: boolean;
  /** Hint printed by the caller when two consecutive low-delta rounds hit
   *  without the non-summary rule also being clean. */
  readonly suggestDownshift: boolean;
}

export function checkConvergence(input: ConvergenceInput): ConvergenceOutcome {
  const delta = input.minDeltaLines ?? CONVERGENCE_DEFAULT_DELTA;

  const prevLowDelta = input.previous.diffLines <= delta;
  const currLowDelta = input.current.diffLines <= delta;
  const bothLowDelta = prevLowDelta && currLowDelta;

  const prevNoNewNonSummary =
    input.previous.nonSummaryCategoriesWithFindings === 0;
  const currNoNewNonSummary =
    input.current.nonSummaryCategoriesWithFindings === 0;
  const bothQuiet = prevNoNewNonSummary && currNoNewNonSummary;

  const converged = bothLowDelta && bothQuiet;

  // Suggest downshift when two consecutive low-delta rounds happen but
  // full convergence didn't fire (i.e., there were still non-summary
  // findings). This is advisory, not halting.
  const suggestDownshift = bothLowDelta && !bothQuiet;

  return { converged, suggestDownshift };
}

// ---------- eight-stop classifier ----------

export type StopReason =
  | "max-rounds"
  | "ready"
  | "semantic-convergence"
  | "lead-ignoring-critiques"
  | "sigint"
  | "reviewers-exhausted"
  | "wall-clock"
  | "budget"
  | "lead-terminal";

export interface ClassifyAllStopsInput {
  /** 1-based round number just completed. */
  readonly currentRoundIndex: number;
  readonly maxRounds: number;
  readonly leadReady: boolean;
  readonly previous: PreviousRoundSignals;
  readonly current: RoundSignals;
  /** How many reviewers are still usable. 0 = both exhausted. */
  readonly reviewerAvailability: number;
  /** `true` iff budget.max_* has not been hit (tokens/cost). */
  readonly budgetOk: boolean;
  /** `true` iff wall-clock has not overrun the "one more round" gate. */
  readonly wallClockOk: boolean;
  readonly leadTerminal: boolean;
  readonly sigintReceived: boolean;
  readonly minDeltaLines?: number;
}

export interface ClassifyAllStopsOutcome {
  readonly stop: boolean;
  readonly reason?: StopReason;
  readonly suggestDownshift: boolean;
  readonly repeatFindings: RepeatFindingsOutcome;
  readonly convergence: ConvergenceOutcome;
}

/**
 * Single-entry detector for all eight stop conditions. Priority order
 * matches SPEC §12: max-rounds, ready, semantic-convergence,
 * repeat-findings-halt, sigint, reviewers-exhausted, budget/wall-clock,
 * lead-terminal. Callers only need to consume `reason` and print.
 */
export function classifyAllStops(
  input: ClassifyAllStopsInput,
): ClassifyAllStopsOutcome {
  const conv = checkConvergence({
    current: input.current,
    previous: input.previous,
    ...(input.minDeltaLines !== undefined
      ? { minDeltaLines: input.minDeltaLines }
      : {}),
  });
  const repeat = checkRepeatFindings({
    current: input.current.findings,
    previous: input.previous.findings,
  });

  // 1. Max rounds.
  if (input.currentRoundIndex >= input.maxRounds) {
    return {
      stop: true,
      reason: "max-rounds",
      suggestDownshift: conv.suggestDownshift,
      repeatFindings: repeat,
      convergence: conv,
    };
  }
  // 2. Reviewer availability zero — checked BEFORE ready / semantic-
  //    convergence (#64). When all reviewers failed, a spec has received
  //    zero review input; allowing ready=true or convergence to fire would
  //    produce a silently un-reviewed output. Surface the availability
  //    problem immediately so the caller can prompt the user.
  if (input.reviewerAvailability <= 0) {
    return {
      stop: true,
      reason: "reviewers-exhausted",
      suggestDownshift: conv.suggestDownshift,
      repeatFindings: repeat,
      convergence: conv,
    };
  }
  // 3. Ready.
  if (input.leadReady) {
    return {
      stop: true,
      reason: "ready",
      suggestDownshift: conv.suggestDownshift,
      repeatFindings: repeat,
      convergence: conv,
    };
  }
  // 4. Semantic convergence.
  if (conv.converged) {
    return {
      stop: true,
      reason: "semantic-convergence",
      suggestDownshift: conv.suggestDownshift,
      repeatFindings: repeat,
      convergence: conv,
    };
  }
  // 5. Repeat-findings halt.
  if (repeat.halt) {
    return {
      stop: true,
      reason: "lead-ignoring-critiques",
      suggestDownshift: conv.suggestDownshift,
      repeatFindings: repeat,
      convergence: conv,
    };
  }
  // 6. SIGINT.
  if (input.sigintReceived) {
    return {
      stop: true,
      reason: "sigint",
      suggestDownshift: conv.suggestDownshift,
      repeatFindings: repeat,
      convergence: conv,
    };
  }
  // 7. Budget / wall-clock. Wall-clock has distinct exit copy per SPEC §7.
  if (!input.wallClockOk) {
    return {
      stop: true,
      reason: "wall-clock",
      suggestDownshift: conv.suggestDownshift,
      repeatFindings: repeat,
      convergence: conv,
    };
  }
  if (!input.budgetOk) {
    return {
      stop: true,
      reason: "budget",
      suggestDownshift: conv.suggestDownshift,
      repeatFindings: repeat,
      convergence: conv,
    };
  }
  // 8. lead_terminal absorbing state.
  if (input.leadTerminal) {
    return {
      stop: true,
      reason: "lead-terminal",
      suggestDownshift: conv.suggestDownshift,
      repeatFindings: repeat,
      convergence: conv,
    };
  }
  return {
    stop: false,
    suggestDownshift: conv.suggestDownshift,
    repeatFindings: repeat,
    convergence: conv,
  };
}

// ---------- exit-4 messaging per sub-reason (SPEC §7) ----------

export function stopReasonMessage(reason: StopReason, slug: string): string {
  switch (reason) {
    case "max-rounds":
      return `samospec: max rounds reached. Review loop exited cleanly.`;
    case "ready":
      return `samospec: lead declared ready=true. Review loop exited.`;
    case "semantic-convergence":
      return `samospec: semantic convergence — two consecutive low-delta rounds. Exited.`;
    case "lead-ignoring-critiques":
      return (
        `samospec: lead is ignoring critiques ` +
        `(≥80% of findings repeated). ` +
        `Edit .samo/spec/${slug}/SPEC.md manually and rerun ` +
        `\`samospec iterate\`, or abort.`
      );
    case "sigint":
      return `samospec: interrupted by user (Ctrl-C).`;
    case "reviewers-exhausted":
      return (
        `samospec: reviewer availability dropped to zero. ` +
        `Continue with one reviewer or abort.`
      );
    case "wall-clock":
      return `samospec: session wall-clock hit — resume to continue.`;
    case "budget":
      return `samospec: budget cap hit — downshift via --effort or raise budget.*.`;
    case "lead-terminal":
      return (
        `samospec: lead_terminal reached. ` +
        `Edit .samo/spec/${slug}/SPEC.md manually or abort.`
      );
  }
}

/** Map a StopReason to SPEC §10 exit codes. */
export function stopReasonExitCode(reason: StopReason): number {
  switch (reason) {
    case "max-rounds":
    case "ready":
    case "semantic-convergence":
      return 0;
    case "sigint":
      return 3;
    case "reviewers-exhausted":
    case "wall-clock":
    case "budget":
    case "lead-terminal":
    case "lead-ignoring-critiques":
      return 4;
  }
}
