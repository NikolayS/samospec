// Copyright 2026 Nikolay Samokhvalov.

// RED tests for #153: implementation runs must carry an explicit
// autonomy policy for merge, scope, follow-up issues, and review
// authority. Defaults are conservative; explicit autonomous choices are
// auditable and render verbatim into prompts.

import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../../src/cli/init.ts";
import {
  DEFAULT_AUTONOMY_POLICY,
  autonomyPolicySnapshotSchema,
  createAutonomyPolicySnapshot,
  parseAutonomyPolicyChoices,
  readAutonomyPolicyFromConfig,
  renderAutonomyPolicyPromptBlock,
} from "../../src/policy/autonomy.ts";

describe("autonomy policy — defaults (#153)", () => {
  test("DEFAULT_CONFIG carries the conservative autonomy policy", () => {
    expect(DEFAULT_CONFIG.autonomy_policy).toEqual(DEFAULT_AUTONOMY_POLICY);
  });

  test("missing config policy resolves to conservative defaults", () => {
    const policy = readAutonomyPolicyFromConfig({ schema_version: 1 });
    expect(policy).toEqual(DEFAULT_AUTONOMY_POLICY);
    expect(policy.merge_authority).toBe("cannot_merge");
    expect(policy.work_scope).toBe("issue_only");
    expect(policy.follow_up_issue_authority).toBe("cannot_create");
    expect(policy.review_authority).toBe("request_review_only");
  });

  test("conservative render says manager/project-owner approval is required", () => {
    const text = renderAutonomyPolicyPromptBlock(DEFAULT_AUTONOMY_POLICY);
    expect(text).toContain(
      "Merge authority: cannot merge; manager/project-owner approval required.",
    );
    expect(text).toContain("Work scope: issue-level only.");
    expect(text).toContain(
      "Follow-up issue authority: cannot create follow-up issues.",
    );
    expect(text).toContain(
      "Review authority: may request REV/reviewer agents; cannot approve own PR.",
    );
  });
});

describe("autonomy policy — explicit choices (#153)", () => {
  test("explicit autonomous policy parses from unambiguous CLI/API ids", () => {
    const parsed = parseAutonomyPolicyChoices({
      mergeAuthority: "can_tag_release_after_gates",
      workScope: "full_dev_sprint",
      followUpIssueAuthority: "can_create",
      reviewAuthority: "request_review_only",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.policy).toEqual({
      merge_authority: "can_tag_release_after_gates",
      work_scope: "full_dev_sprint",
      follow_up_issue_authority: "can_create",
      review_authority: "request_review_only",
    });
  });

  test("ambiguous shorthand is rejected", () => {
    const parsed = parseAutonomyPolicyChoices({
      mergeAuthority: "auto",
      workScope: "full",
      followUpIssueAuthority: "yes",
      reviewAuthority: "approve",
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("merge authority");
    expect(parsed.error).toContain("can_merge_after_gates");
    expect(parsed.error).toContain("can_tag_release_after_gates");
  });

  test("snapshot is auditable and includes the rendered policy verbatim", () => {
    const policy = {
      merge_authority: "can_merge_after_gates",
      work_scope: "full_dev_sprint",
      follow_up_issue_authority: "can_propose",
      review_authority: "request_review_only",
    } as const;
    const snapshot = createAutonomyPolicySnapshot({
      policy,
      recordedAt: "2026-05-08T12:00:00.000Z",
      source: "cli",
    });
    expect(snapshot.schema_version).toBe(1);
    expect(snapshot.recorded_at).toBe("2026-05-08T12:00:00.000Z");
    expect(snapshot.source).toBe("cli");
    expect(snapshot.policy).toEqual(policy);
    expect(snapshot.rendered_policy).toBe(
      renderAutonomyPolicyPromptBlock(policy),
    );
    expect(snapshot.rendered_policy).toContain(
      "Merge authority: can merge after required gates pass.",
    );
    expect(snapshot.rendered_policy).toContain(
      "Follow-up issue authority: may propose follow-up issues for manager/project-owner approval.",
    );
  });

  test("snapshot rejects rendered policy text that contradicts structured policy", () => {
    const parsed = autonomyPolicySnapshotSchema.safeParse({
      schema_version: 1,
      policy: DEFAULT_AUTONOMY_POLICY,
      rendered_policy: renderAutonomyPolicyPromptBlock({
        merge_authority: "can_merge_after_gates",
        work_scope: "full_dev_sprint",
        follow_up_issue_authority: "can_create",
        review_authority: "request_review_only",
      }),
      recorded_at: "2026-05-08T12:00:00.000Z",
      source: "api",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.path).toEqual(["rendered_policy"]);
  });
});
