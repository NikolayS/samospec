// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §10 + Issue #96 — single source of truth for the "next action"
 * hint shared by `samospec iterate` stdout tail, `samospec status`, and
 * the `.samo/spec/<slug>/TLDR.md` renderer. All three surfaces MUST
 * consult this helper so the user sees one consistent recommendation.
 *
 * Decision order (first match wins):
 *
 *   1. Already published (phase = "publish" AND published_at set) →
 *      `already published as <version>` (or `already published` when
 *      no version is recorded).
 *   2. `lead_terminal` — either round_state = "lead_terminal" or the
 *      persisted exit.reason starts with "lead-terminal". Manual edit
 *      is the only recovery path per SPEC §7.
 *   3. Converged success — exit.reason ∈ READY_REASONS → publish.
 *   4. Halted but recoverable — exit.reason ∈ RECOVERABLE_REASONS →
 *      run iterate again.
 *   5. Generic / unknown exit reason with a non-null exit → iterate.
 *   6. In-flight round (round_state ∉ committed, exit = null) → resume.
 *   7. Committed round with no exit → iterate (either pre-iterate from
 *      draft phase or mid-review-loop ready for the next round).
 *
 * The function is pure: no I/O, no side effects, deterministic on input.
 */

import type { State } from "./types.ts";

/**
 * Stop reasons that mean the spec has converged and the next user
 * action is `samospec publish <slug>`. These correspond to SPEC §12
 * conditions 1 + 3 + 4 + 5 — all cases where the review loop exited
 * cleanly with a spec ready to ship.
 */
const READY_REASONS: ReadonlySet<string> = new Set([
  "ready",
  "max-rounds",
  "semantic-convergence",
  "lead-ignoring-critiques",
]);

/**
 * Stop reasons that interrupted the loop without converging. The user
 * should re-invoke `samospec iterate` (or edit SPEC.md and retry).
 */
const RECOVERABLE_REASONS: ReadonlySet<string> = new Set([
  "wall-clock",
  "budget",
  "sigint",
  "reviewers-exhausted",
  "push-consent-interrupted",
]);

/**
 * Compute the canonical single-line next-action string for a given
 * state. Callers prepend their own presentation prefix (e.g. "next: "
 * for iterate stdout and "- next: " for status); the return value here
 * is the action alone.
 */
export function computeNextAction(state: State, slug: string): string {
  // 1. Published terminal state.
  if (state.phase === "publish" && state.published_at !== undefined) {
    const version = state.published_version;
    if (version !== undefined && version.length > 0) {
      return `already published as ${version}`;
    }
    return "already published";
  }

  // 2. lead_terminal — either the current round_state or an exit reason
  //    that flags terminal refusal. SPEC §7 sub-reasons are serialized
  //    as "lead-terminal:<sub>" so we match by prefix.
  if (state.round_state === "lead_terminal") {
    return `edit .samo/spec/${slug}/SPEC.md manually to recover`;
  }
  if (state.exit?.reason.startsWith("lead-terminal") === true) {
    return `edit .samo/spec/${slug}/SPEC.md manually to recover`;
  }

  // 3-5. An exit has been persisted — route by reason.
  if (state.exit !== null) {
    if (READY_REASONS.has(state.exit.reason)) {
      return `samospec publish ${slug}`;
    }
    if (RECOVERABLE_REASONS.has(state.exit.reason)) {
      return `samospec iterate ${slug}`;
    }
    // Unknown / future exit reason — safe fallback is the same
    // recoverable hint so no surface ever shows a blank next-action.
    return `samospec iterate ${slug}`;
  }

  // 6. In-flight round: any non-committed round_state (planned /
  //    running / reviews_collected / lead_revised) means a prior
  //    process aborted mid-round. Resume recovers without losing work.
  if (state.round_state !== "committed") {
    return `samospec resume ${slug}`;
  }

  // 7. Committed, no exit. Covers:
  //    - pre-iterate (phase=draft, round_index=0)
  //    - mid-review-loop ready for the next round (phase=review_loop,
  //      round_index>=1, no exit)
  //    Both route to `samospec iterate`.
  return `samospec iterate ${slug}`;
}
