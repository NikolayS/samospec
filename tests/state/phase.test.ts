// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import {
  isLegalPhaseTransition,
  advancePhase,
  PHASE_ORDER,
  PhaseTransitionError,
} from "../../src/state/phase.ts";
import { PHASES, type Phase } from "../../src/state/types.ts";

describe("state/phase — phase table (SPEC §5)", () => {
  test("PHASE_ORDER matches the canonical SPEC §5 order", () => {
    expect(PHASE_ORDER).toEqual([...PHASES]);
  });
});

describe("state/phase — legality predicate", () => {
  test("forward-by-one transitions are legal", () => {
    for (let i = 0; i < PHASE_ORDER.length - 1; i++) {
      const from = PHASE_ORDER[i] as Phase;
      const to = PHASE_ORDER[i + 1] as Phase;
      expect(isLegalPhaseTransition(from, to)).toBe(true);
    }
  });

  test("self-transitions are legal (re-entrancy during retries)", () => {
    for (const p of PHASE_ORDER) {
      expect(isLegalPhaseTransition(p, p)).toBe(true);
    }
  });

  test("backward transitions are always illegal", () => {
    for (let i = 1; i < PHASE_ORDER.length; i++) {
      for (let j = 0; j < i; j++) {
        const from = PHASE_ORDER[i] as Phase;
        const to = PHASE_ORDER[j] as Phase;
        expect(isLegalPhaseTransition(from, to)).toBe(false);
      }
    }
  });

  test("skipping phases forward is illegal", () => {
    expect(isLegalPhaseTransition("detect", "persona")).toBe(false);
    expect(isLegalPhaseTransition("context", "draft")).toBe(false);
    expect(isLegalPhaseTransition("interview", "publish")).toBe(false);
  });
});

describe("state/phase — advancePhase", () => {
  test("advances forward by one and stamps updated_at", () => {
    const before = {
      slug: "demo",
      phase: "detect" as Phase,
      round_index: 0,
      version: "0.0.0",
      persona: null,
      push_consent: null,
      calibration: null,
      remote_stale: false,
      coupled_fallback: false,
      round_state: "planned" as const,
      exit: null,
      created_at: "2026-04-19T00:00:00.000Z",
      updated_at: "2026-04-19T00:00:00.000Z",
    };
    const after = advancePhase(before, "branch_lock_preflight", {
      now: "2026-04-19T00:00:01.000Z",
    });
    expect(after.phase).toBe("branch_lock_preflight");
    expect(after.updated_at).toBe("2026-04-19T00:00:01.000Z");
    expect(after.created_at).toBe("2026-04-19T00:00:00.000Z");
  });

  test("throws PhaseTransitionError for illegal backward move", () => {
    const before = {
      slug: "demo",
      phase: "review_loop" as Phase,
      round_index: 0,
      version: "0.0.0",
      persona: null,
      push_consent: null,
      calibration: null,
      remote_stale: false,
      coupled_fallback: false,
      round_state: "planned" as const,
      exit: null,
      created_at: "2026-04-19T00:00:00.000Z",
      updated_at: "2026-04-19T00:00:00.000Z",
    };
    expect(() =>
      advancePhase(before, "detect", { now: "2026-04-19T00:00:01.000Z" }),
    ).toThrow(PhaseTransitionError);
  });

  test("allows self-transition to stamp updated_at without phase change", () => {
    const before = {
      slug: "demo",
      phase: "interview" as Phase,
      round_index: 0,
      version: "0.0.0",
      persona: null,
      push_consent: null,
      calibration: null,
      remote_stale: false,
      coupled_fallback: false,
      round_state: "planned" as const,
      exit: null,
      created_at: "2026-04-19T00:00:00.000Z",
      updated_at: "2026-04-19T00:00:00.000Z",
    };
    const after = advancePhase(before, "interview", {
      now: "2026-04-19T00:00:01.000Z",
    });
    expect(after.phase).toBe("interview");
    expect(after.updated_at).toBe("2026-04-19T00:00:01.000Z");
  });
});
