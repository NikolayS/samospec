// Copyright 2026 Nikolay Samokhvalov.

// RED tests for #153: state.json must be able to persist an auditable
// autonomy policy snapshot per implementation run.

import { describe, expect, test } from "bun:test";

import { createAutonomyPolicySnapshot } from "../../src/policy/autonomy.ts";
import { newState } from "../../src/state/store.ts";
import { stateSchema } from "../../src/state/types.ts";

describe("state.json — implementation autonomy policy snapshot (#153)", () => {
  test("fresh state has no implementation-run autonomy snapshot", () => {
    const state = newState({
      slug: "demo",
      now: "2026-05-08T12:00:00.000Z",
    });
    expect(state.implementation_autonomy).toBeUndefined();
  });

  test("state schema accepts an auditable implementation autonomy snapshot", () => {
    const base = newState({
      slug: "demo",
      now: "2026-05-08T12:00:00.000Z",
    });
    const snapshot = createAutonomyPolicySnapshot({
      policy: {
        merge_authority: "can_merge_after_gates",
        work_scope: "issue_only",
        follow_up_issue_authority: "can_create",
        review_authority: "request_review_only",
      },
      recordedAt: "2026-05-08T12:01:00.000Z",
      source: "config",
    });
    const parsed = stateSchema.parse({
      ...base,
      implementation_autonomy: snapshot,
    });
    expect(parsed.implementation_autonomy).toEqual(snapshot);
    expect(parsed.implementation_autonomy?.rendered_policy).toContain(
      "Review authority: may request REV/reviewer agents; cannot approve own PR.",
    );
  });
});
