// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import {
  evaluatePrLifecycle,
  type PrLifecycleInput,
} from "../../src/publish/lifecycle-gates.ts";

function mergeReadyFixture(
  overrides: Partial<PrLifecycleInput> = {},
): PrLifecycleInput {
  return {
    prNumber: 155,
    authorLogin: "feature-author",
    ci: {
      state: "success",
      source: "github",
      detailsUrl: "https://github.com/NikolayS/samospec/actions/runs/1",
    },
    rev: {
      state: "recorded",
      commentPosted: true,
      reportUrl: "https://github.com/NikolayS/samospec/pull/1#issuecomment-1",
      findings: [
        {
          id: "rev-tests-1",
          severity: "non-blocking",
          category: "tests",
          message: "Consider expanding release smoke coverage later.",
        },
      ],
    },
    manualTesting: {
      state: "present",
      evidence: "Ran publish dry-run against a fixture PR.",
    },
    policy: {
      mergeAllowed: true,
      releaseAllowed: true,
    },
    ...overrides,
  };
}

describe("evaluatePrLifecycle", () => {
  test("blocks merge without green GitHub CI", () => {
    const result = evaluatePrLifecycle(
      mergeReadyFixture({
        ci: {
          state: "pending",
          source: "github",
          detailsUrl: "https://github.com/NikolayS/samospec/actions/runs/2",
        },
      }),
    );

    expect(result.lifecycleState).toBe("blocked");
    expect(result.canMerge).toBe(false);
    expect(result.blockers).toContainEqual({
      code: "ci-not-green",
      message:
        "GitHub CI must be green before merge. Current CI state: pending.",
      action: "Wait for CI to pass or fix the failing checks.",
    });
  });

  test("blocks merge without a posted REV result", () => {
    const result = evaluatePrLifecycle(
      mergeReadyFixture({
        rev: { state: "missing" },
      }),
    );

    expect(result.lifecycleState).toBe("blocked");
    expect(result.canMerge).toBe(false);
    expect(result.blockers).toContainEqual({
      code: "rev-missing",
      message: "REV must run against the PR diff before merge.",
      action:
        "Run REV, ignore SOC2-only findings, and post the report as a PR comment.",
    });
  });

  test("blocks merge when meaningful manual testing evidence is missing", () => {
    const result = evaluatePrLifecycle(
      mergeReadyFixture({
        manualTesting: { state: "missing" },
      }),
    );

    expect(result.lifecycleState).toBe("blocked");
    expect(result.canMerge).toBe(false);
    expect(result.blockers).toContainEqual({
      code: "testing-evidence-missing",
      message: "Manual testing evidence must be posted before merge.",
      action:
        "Add a PR comment or PR body section with the focused manual testing evidence.",
    });
  });

  test("routes blocking REV findings back to the PR author", () => {
    const result = evaluatePrLifecycle(
      mergeReadyFixture({
        rev: {
          state: "recorded",
          commentPosted: true,
          findings: [
            {
              id: "rev-bugs-1",
              severity: "blocking",
              category: "bugs",
              message: "Merge path ignores failed checks.",
            },
            {
              id: "rev-soc2-1",
              severity: "blocking",
              category: "soc2",
              message: "Missing second human reviewer.",
            },
          ],
        },
      }),
    );

    expect(result.lifecycleState).toBe("needs-author-action");
    expect(result.canMerge).toBe(false);
    expect(result.actions.assignTo).toBe("feature-author");
    expect(result.blockers).toContainEqual({
      code: "rev-blocking-findings",
      message: "REV has 1 blocking finding that must be fixed.",
      action: "Assign feature-author and rerun REV after fixes land.",
    });
  });

  test("advances a passing fixture PR state to merge-ready", () => {
    const result = evaluatePrLifecycle(mergeReadyFixture());

    expect(result.lifecycleState).toBe("merge-ready");
    expect(result.canMerge).toBe(true);
    expect(result.canRelease).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.actions).toEqual({});
  });
});
