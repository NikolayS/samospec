// Copyright 2026 Nikolay Samokhvalov.

// RED tests for #153: issue/PR agent prompts must include the chosen
// autonomy policy verbatim.

import { describe, expect, test } from "bun:test";

import { buildAskPrompt, buildRevisePrompt } from "../../src/adapter/claude.ts";
import {
  createAutonomyPolicySnapshot,
  renderAutonomyPolicyPromptBlock,
} from "../../src/policy/autonomy.ts";
import type { AskInput, ReviseInput } from "../../src/adapter/types.ts";

const policy = {
  merge_authority: "can_merge_after_gates",
  work_scope: "full_dev_sprint",
  follow_up_issue_authority: "can_create",
  review_authority: "request_review_only",
} as const;

const snapshot = createAutonomyPolicySnapshot({
  policy,
  recordedAt: "2026-05-08T12:00:00.000Z",
  source: "api",
});

describe("agent prompt rendering — autonomy policy (#153)", () => {
  test("ask prompt includes the rendered autonomy policy verbatim", () => {
    const input: AskInput = {
      prompt: "Create the implementation issue prompt.",
      context: "Issue #153",
      opts: { effort: "max", timeout: 120_000 },
      autonomy_policy: snapshot,
    };
    const prompt = buildAskPrompt(input);
    expect(prompt).toContain(renderAutonomyPolicyPromptBlock(policy));
    expect(prompt).toContain(snapshot.rendered_policy);
  });

  test("revise prompt includes the rendered autonomy policy verbatim", () => {
    const input: ReviseInput = {
      spec: "# SPEC\n\n## Implementation plan\n\nCreate issue prompts.",
      reviews: [],
      decisions_history: [],
      opts: { effort: "max", timeout: 600_000 },
      autonomy_policy: snapshot,
    };
    const prompt = buildRevisePrompt(input);
    expect(prompt).toContain(snapshot.rendered_policy);
    expect(prompt).toContain(
      "Follow-up issue authority: may create follow-up issues directly.",
    );
  });
});
