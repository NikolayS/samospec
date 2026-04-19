// Copyright 2026 Nikolay Samokhvalov.

import { PHASES, type Phase, type State } from "./types.ts";

/**
 * Canonical phase order per SPEC §5. Exported as a readonly array so
 * callers can iterate deterministically — `PHASES` (the type alias) is
 * used for schema validation, `PHASE_ORDER` is the operational vector.
 */
export const PHASE_ORDER: readonly Phase[] = PHASES;

const PHASE_INDEX: ReadonlyMap<Phase, number> = new Map(
  PHASE_ORDER.map((p, i) => [p, i]),
);

/**
 * Raised when advancePhase is called with an illegal transition.
 * Caller (CLI) translates to exit 1 with the included message.
 */
export class PhaseTransitionError extends Error {
  public readonly from: Phase;
  public readonly to: Phase;
  constructor(from: Phase, to: Phase) {
    super(`illegal phase transition: ${from} -> ${to}`);
    this.name = "PhaseTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * Returns true if `to` is the same phase or the next phase after `from`.
 * Backward or skipping transitions always return false (SPEC §5: phase
 * never goes backwards; §13 test 1 invariant).
 */
export function isLegalPhaseTransition(from: Phase, to: Phase): boolean {
  if (from === to) return true;
  const fi = PHASE_INDEX.get(from);
  const ti = PHASE_INDEX.get(to);
  if (fi === undefined || ti === undefined) return false;
  return ti === fi + 1;
}

export interface AdvancePhaseOpts {
  readonly now: string;
}

/**
 * Produce a new State with `phase` advanced to `to` and `updated_at`
 * bumped to `opts.now`. Throws PhaseTransitionError on illegal moves;
 * the schema validation happens at the write-state boundary.
 */
export function advancePhase(
  state: State,
  to: Phase,
  opts: AdvancePhaseOpts,
): State {
  if (!isLegalPhaseTransition(state.phase, to)) {
    throw new PhaseTransitionError(state.phase, to);
  }
  return {
    ...state,
    phase: to,
    updated_at: opts.now,
  };
}
