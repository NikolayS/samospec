// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import type { Finding } from "../../src/adapter/types.ts";
import {
  CONVERGENCE_DEFAULT_DELTA,
  MIN_FINDINGS_FLOOR,
  REPEAT_JACCARD_THRESHOLD,
  REPEAT_RATIO_THRESHOLD,
  checkConvergence,
  checkRepeatFindings,
  classifyAllStops,
  type PreviousRoundSignals,
  type RoundSignals,
} from "../../src/loop/stopping.ts";

// SPEC §12 condition 4 — concrete algorithm. Helper builds findings in
// one category so the test reads naturally.
function mkFinding(text: string, category: Finding["category"]): Finding {
  return { category, text, severity: "minor" };
}

describe("loop/stopping — thresholds (SPEC §12 condition 4)", () => {
  test("Jaccard threshold is 0.8", () => {
    expect(REPEAT_JACCARD_THRESHOLD).toBe(0.8);
  });
  test("Repeat-ratio threshold is 0.8", () => {
    expect(REPEAT_RATIO_THRESHOLD).toBe(0.8);
  });
  test("Minimum-findings floor is 5", () => {
    expect(MIN_FINDINGS_FLOOR).toBe(5);
  });
  test("Default convergence min_delta_lines is 20", () => {
    expect(CONVERGENCE_DEFAULT_DELTA).toBe(20);
  });
});

describe("loop/stopping — repeat-findings halt", () => {
  test("does not trigger when round has fewer than 5 findings", () => {
    // Floor: ≥5 findings required. 4 identical findings → still no halt.
    const curr = Array.from({ length: 4 }, () =>
      mkFinding("the spec is ambiguous here", "ambiguity"),
    );
    const prev = [...curr];
    const outcome = checkRepeatFindings({ current: curr, previous: prev });
    expect(outcome.halt).toBe(false);
    expect(outcome.reason).toBe("floor_not_met");
  });

  test("triggers when ≥80% of ≥5 findings repeat with Jaccard ≥ 0.8", () => {
    const curr: Finding[] = [
      mkFinding("the spec is ambiguous about refunds", "ambiguity"),
      mkFinding("the spec is ambiguous about returns", "ambiguity"),
      mkFinding("the spec is ambiguous about payments", "ambiguity"),
      mkFinding("the spec is ambiguous about shipping", "ambiguity"),
      mkFinding("brand-new finding unlike anything else", "weak-testing"),
    ];
    // Prior round near-identical first four (same category, similar wording).
    const prev: Finding[] = [
      mkFinding("the spec is ambiguous about refunds!", "ambiguity"),
      mkFinding("the spec is ambiguous about returns.", "ambiguity"),
      mkFinding("the spec is ambiguous about payments", "ambiguity"),
      mkFinding("the spec is ambiguous about shipping", "ambiguity"),
    ];
    const outcome = checkRepeatFindings({ current: curr, previous: prev });
    expect(outcome.halt).toBe(true);
    expect(outcome.reason).toBe("lead-ignoring-critiques");
    expect(outcome.repeatedCount).toBe(4);
    expect(outcome.totalCount).toBe(5);
  });

  test("does NOT trigger when repeat ratio is below 80%", () => {
    const curr: Finding[] = [
      mkFinding("the spec is ambiguous about refunds", "ambiguity"),
      mkFinding("the spec is ambiguous about returns", "ambiguity"),
      mkFinding("new finding about payments", "missing-risk"),
      mkFinding("new finding about shipping", "weak-testing"),
      mkFinding("brand-new finding #5", "weak-testing"),
    ];
    const prev: Finding[] = [
      mkFinding("the spec is ambiguous about refunds", "ambiguity"),
      mkFinding("the spec is ambiguous about returns", "ambiguity"),
    ];
    const outcome = checkRepeatFindings({ current: curr, previous: prev });
    expect(outcome.halt).toBe(false);
    expect(outcome.reason).toBe("below_ratio");
  });

  test("same-category-only match: cross-category wording doesn't count", () => {
    // `text` matches literally but category differs — must NOT be repeat.
    const curr: Finding[] = [
      mkFinding("identical wording", "ambiguity"),
      mkFinding("identical wording", "ambiguity"),
      mkFinding("identical wording", "ambiguity"),
      mkFinding("identical wording", "ambiguity"),
      mkFinding("identical wording", "ambiguity"),
    ];
    const prev: Finding[] = [
      mkFinding("identical wording", "weak-testing"),
      mkFinding("identical wording", "weak-testing"),
      mkFinding("identical wording", "weak-testing"),
      mkFinding("identical wording", "weak-testing"),
    ];
    const outcome = checkRepeatFindings({ current: curr, previous: prev });
    expect(outcome.halt).toBe(false);
  });
});

describe("loop/stopping — semantic convergence (SPEC §12 condition 3)", () => {
  test("non-converged when diff > threshold", () => {
    const prev: PreviousRoundSignals = {
      findings: [],
      diffLines: 0,
      nonSummaryCategoriesWithFindings: 0,
    };
    const curr: RoundSignals = {
      findings: [],
      diffLines: 50,
      nonSummaryCategoriesWithFindings: 0,
    };
    expect(checkConvergence({ current: curr, previous: prev }).converged).toBe(
      false,
    );
  });

  test("non-converged when non-summary categories had new findings", () => {
    const prev: PreviousRoundSignals = {
      findings: [],
      diffLines: 10,
      nonSummaryCategoriesWithFindings: 1,
    };
    const curr: RoundSignals = {
      findings: [],
      diffLines: 10,
      nonSummaryCategoriesWithFindings: 1,
    };
    expect(checkConvergence({ current: curr, previous: prev }).converged).toBe(
      false,
    );
  });

  test("converged when both rounds had diff≤20 AND no new non-summary findings", () => {
    const prev: PreviousRoundSignals = {
      findings: [],
      diffLines: 5,
      nonSummaryCategoriesWithFindings: 0,
    };
    const curr: RoundSignals = {
      findings: [],
      diffLines: 3,
      nonSummaryCategoriesWithFindings: 0,
    };
    const out = checkConvergence({ current: curr, previous: prev });
    expect(out.converged).toBe(true);
    expect(out.suggestDownshift).toBe(false);
  });

  test("two consecutive low-delta rounds without full convergence -> suggest downshift", () => {
    const prev: PreviousRoundSignals = {
      findings: [],
      diffLines: 5,
      nonSummaryCategoriesWithFindings: 1, // had new findings, so not converged
    };
    const curr: RoundSignals = {
      findings: [],
      diffLines: 4,
      nonSummaryCategoriesWithFindings: 1,
    };
    const out = checkConvergence({ current: curr, previous: prev });
    expect(out.converged).toBe(false);
    expect(out.suggestDownshift).toBe(true);
  });

  test("one low-delta round alone does NOT suggest downshift", () => {
    const prev: PreviousRoundSignals = {
      findings: [],
      diffLines: 50,
      nonSummaryCategoriesWithFindings: 1,
    };
    const curr: RoundSignals = {
      findings: [],
      diffLines: 5,
      nonSummaryCategoriesWithFindings: 1,
    };
    const out = checkConvergence({ current: curr, previous: prev });
    expect(out.converged).toBe(false);
    expect(out.suggestDownshift).toBe(false);
  });
});

describe("loop/stopping — classifyAllStops (SPEC §12 eight conditions)", () => {
  // Default signals: "still active" (not converged, non-summary findings).
  // Individual tests override the fields relevant to the condition
  // under test so the priority order is isolated.
  const signals: RoundSignals = {
    findings: [],
    diffLines: 100,
    nonSummaryCategoriesWithFindings: 2,
  };
  const prev: PreviousRoundSignals = {
    findings: [],
    diffLines: 100,
    nonSummaryCategoriesWithFindings: 2,
  };
  // Convergence-friendly override used by the convergence test only.
  const signalsConverged: RoundSignals = {
    findings: [],
    diffLines: 0,
    nonSummaryCategoriesWithFindings: 0,
  };
  const prevConverged: PreviousRoundSignals = {
    findings: [],
    diffLines: 0,
    nonSummaryCategoriesWithFindings: 0,
  };

  test("max rounds fires first if hit", () => {
    const stop = classifyAllStops({
      currentRoundIndex: 10,
      maxRounds: 10,
      leadReady: false,
      previous: prev,
      current: signals,
      reviewerAvailability: 2,
      wallClockOk: true,
      budgetOk: true,
      leadTerminal: false,
      sigintReceived: false,
    });
    expect(stop.stop).toBe(true);
    expect(stop.reason).toBe("max-rounds");
  });

  test("ready=true fires", () => {
    const stop = classifyAllStops({
      currentRoundIndex: 2,
      maxRounds: 10,
      leadReady: true,
      previous: prev,
      current: signals,
      reviewerAvailability: 2,
      wallClockOk: true,
      budgetOk: true,
      leadTerminal: false,
      sigintReceived: false,
    });
    expect(stop.stop).toBe(true);
    expect(stop.reason).toBe("ready");
  });

  test("semantic convergence fires", () => {
    const stop = classifyAllStops({
      currentRoundIndex: 2,
      maxRounds: 10,
      leadReady: false,
      previous: prevConverged,
      current: signalsConverged,
      reviewerAvailability: 2,
      wallClockOk: true,
      budgetOk: true,
      leadTerminal: false,
      sigintReceived: false,
    });
    expect(stop.stop).toBe(true);
    expect(stop.reason).toBe("semantic-convergence");
  });

  test("SIGINT fires (condition 5)", () => {
    const stop = classifyAllStops({
      currentRoundIndex: 2,
      maxRounds: 10,
      leadReady: false,
      previous: prev,
      current: signals,
      reviewerAvailability: 2,
      wallClockOk: true,
      budgetOk: true,
      leadTerminal: false,
      sigintReceived: true,
    });
    expect(stop.stop).toBe(true);
    expect(stop.reason).toBe("sigint");
  });

  test("reviewer availability zero fires (condition 6)", () => {
    const stop = classifyAllStops({
      currentRoundIndex: 2,
      maxRounds: 10,
      leadReady: false,
      previous: prev,
      current: signals,
      reviewerAvailability: 0,
      wallClockOk: true,
      budgetOk: true,
      leadTerminal: false,
      sigintReceived: false,
    });
    expect(stop.stop).toBe(true);
    expect(stop.reason).toBe("reviewers-exhausted");
  });

  test("budget / wall-clock fires (condition 7)", () => {
    const stop = classifyAllStops({
      currentRoundIndex: 2,
      maxRounds: 10,
      leadReady: false,
      previous: prev,
      current: signals,
      reviewerAvailability: 2,
      wallClockOk: false,
      budgetOk: true,
      leadTerminal: false,
      sigintReceived: false,
    });
    expect(stop.stop).toBe(true);
    expect(stop.reason).toBe("wall-clock");
  });

  test("lead_terminal fires (condition 8)", () => {
    const stop = classifyAllStops({
      currentRoundIndex: 2,
      maxRounds: 10,
      leadReady: false,
      previous: prev,
      current: signals,
      reviewerAvailability: 2,
      wallClockOk: true,
      budgetOk: true,
      leadTerminal: true,
      sigintReceived: false,
    });
    expect(stop.stop).toBe(true);
    expect(stop.reason).toBe("lead-terminal");
  });

  test("none fires -> stop=false", () => {
    const stop = classifyAllStops({
      currentRoundIndex: 2,
      maxRounds: 10,
      leadReady: false,
      previous: {
        ...prev,
        diffLines: 100,
        nonSummaryCategoriesWithFindings: 2,
      },
      current: {
        ...signals,
        diffLines: 100,
        nonSummaryCategoriesWithFindings: 2,
      },
      reviewerAvailability: 2,
      wallClockOk: true,
      budgetOk: true,
      leadTerminal: false,
      sigintReceived: false,
    });
    expect(stop.stop).toBe(false);
  });
});
