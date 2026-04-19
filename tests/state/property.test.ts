// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PhaseTransitionError,
  advancePhase,
  PHASE_ORDER,
} from "../../src/state/phase.ts";
import {
  ROUND_TRANSITIONS,
  RoundTransitionError,
  applyRoundTransition,
} from "../../src/state/round.ts";
import { readState, writeState, newState } from "../../src/state/store.ts";
import {
  ROUND_STATES,
  type Phase,
  type RoundState,
  type State,
} from "../../src/state/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-prop-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// Arbitrary: non-negative integer timestamp in ISO form.
const isoTimeArb = fc
  .integer({ min: 0, max: 4_000_000_000_000 })
  .map((ms) => new Date(ms).toISOString());

type Action =
  | { readonly kind: "advancePhase"; readonly to: Phase; readonly now: string }
  | {
      readonly kind: "applyRound";
      readonly to: RoundState;
      readonly now: string;
    };

const phaseActionArb: fc.Arbitrary<Action> = fc.record({
  kind: fc.constant("advancePhase" as const),
  to: fc.constantFrom(...PHASE_ORDER),
  now: isoTimeArb,
});

const roundActionArb: fc.Arbitrary<Action> = fc.record({
  kind: fc.constant("applyRound" as const),
  to: fc.constantFrom(...ROUND_STATES),
  now: isoTimeArb,
});

const actionArb = fc.oneof(phaseActionArb, roundActionArb);

function applyAction(state: State, a: Action): State {
  if (a.kind === "advancePhase") {
    return advancePhase(state, a.to, { now: a.now });
  }
  return applyRoundTransition(state, a.to, { now: a.now });
}

describe("state/phase + state/round — property-based invariants (SPEC §13 test 1)", () => {
  test("state.json is always parseable after any legal action sequence", () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 30 }), (actions) => {
        const file = path.join(tmp, `state-${Math.random()}.json`);
        let state = newState({
          slug: "demo",
          now: "2026-04-19T00:00:00.000Z",
        });
        writeState(file, state);

        for (const a of actions) {
          try {
            state = applyAction(state, a);
            writeState(file, state);
          } catch (err) {
            if (
              err instanceof PhaseTransitionError ||
              err instanceof RoundTransitionError
            ) {
              continue; // illegal action: ignored, file must remain valid
            }
            throw err;
          }
          const reread = readState(file);
          expect(reread).toEqual(state);
        }
      }),
      { numRuns: 150 },
    );
  });

  test("phase never goes backwards through any legal sequence", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...PHASE_ORDER), { maxLength: 40 }),
        fc.array(isoTimeArb, { maxLength: 40 }),
        (targets, times) => {
          let state = newState({
            slug: "demo",
            now: "2026-04-19T00:00:00.000Z",
          });
          let prevIndex = PHASE_ORDER.indexOf(state.phase);
          for (let i = 0; i < targets.length; i++) {
            const to = targets[i];
            const now = times[i] ?? "2026-04-19T00:00:00.000Z";
            if (to === undefined) continue;
            try {
              state = advancePhase(state, to, { now });
            } catch {
              continue;
            }
            const idx = PHASE_ORDER.indexOf(state.phase);
            expect(idx).toBeGreaterThanOrEqual(prevIndex);
            prevIndex = idx;
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  test("version is monotonically non-decreasing across writes", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            major: fc.integer({ min: 0, max: 10 }),
            minor: fc.integer({ min: 0, max: 99 }),
            patch: fc.integer({ min: 0, max: 99 }),
          }),
          { maxLength: 20 },
        ),
        (bumps) => {
          const file = path.join(tmp, `state-${Math.random()}.json`);
          let state = newState({
            slug: "demo",
            now: "2026-04-19T00:00:00.000Z",
          });
          writeState(file, state);
          let prev = state.version;
          const sorted = [...bumps].sort(
            (a, b) =>
              a.major - b.major || a.minor - b.minor || a.patch - b.patch,
          );
          for (const b of sorted) {
            const next = `${b.major}.${b.minor}.${b.patch}`;
            const bumpedState: State = {
              ...state,
              version: next,
              updated_at: "2026-04-19T00:00:01.000Z",
            };
            // Only write when non-decreasing — we are asserting invariance
            // under the write path, not testing the external bumper.
            if (cmpSemver(next, prev) < 0) continue;
            state = bumpedState;
            writeState(file, state);
            const reread = readState(file);
            expect(reread?.version).toBe(next);
            expect(
              cmpSemver(reread?.version ?? "0.0.0", prev),
            ).toBeGreaterThanOrEqual(0);
            prev = next;
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  test("round transitions always land on a state listed in ROUND_TRANSITIONS", () => {
    fc.assert(
      fc.property(fc.array(roundActionArb, { maxLength: 50 }), (actions) => {
        let state = newState({
          slug: "demo",
          now: "2026-04-19T00:00:00.000Z",
        });
        for (const a of actions) {
          const before = state.round_state;
          const allowed = ROUND_TRANSITIONS[before];
          try {
            state = applyAction(state, a);
          } catch (err) {
            if (err instanceof RoundTransitionError) {
              expect(allowed).not.toContain(
                a.kind === "applyRound" ? a.to : before,
              );
              continue;
            }
            throw err;
          }
          if (a.kind !== "applyRound") continue;
          expect(allowed).toContain(a.to);
        }
      }),
      { numRuns: 150 },
    );
  });
});

function cmpSemver(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number(x));
  const pb = b.split(".").map((x) => Number(x));
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}
