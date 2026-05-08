// Copyright 2026 Nikolay Samokhvalov.

import { z } from "zod";

export const AUTONOMY_POLICY_SCHEMA_VERSION = 1 as const;

export const mergeAuthoritySchema = z.enum([
  "cannot_merge",
  "can_merge_after_gates",
  "can_tag_release_after_gates",
]);
export type MergeAuthority = z.infer<typeof mergeAuthoritySchema>;

export const workScopeSchema = z.enum(["issue_only", "full_dev_sprint"]);
export type WorkScope = z.infer<typeof workScopeSchema>;

export const followUpIssueAuthoritySchema = z.enum([
  "cannot_create",
  "can_propose",
  "can_create",
]);
export type FollowUpIssueAuthority = z.infer<
  typeof followUpIssueAuthoritySchema
>;

export const reviewAuthoritySchema = z.enum(["request_review_only"]);
export type ReviewAuthority = z.infer<typeof reviewAuthoritySchema>;

export const autonomyPolicySchema = z
  .object({
    merge_authority: mergeAuthoritySchema,
    work_scope: workScopeSchema,
    follow_up_issue_authority: followUpIssueAuthoritySchema,
    review_authority: reviewAuthoritySchema,
  })
  .strict();
export type AutonomyPolicy = z.infer<typeof autonomyPolicySchema>;

const isoTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/,
    "must be an ISO 8601 UTC timestamp ending in 'Z'",
  );

export const autonomyPolicySnapshotSchema = z
  .object({
    schema_version: z.literal(AUTONOMY_POLICY_SCHEMA_VERSION),
    policy: autonomyPolicySchema,
    rendered_policy: z.string().min(1),
    recorded_at: isoTimestampSchema,
    source: z.enum(["config", "cli", "api"]),
  })
  .strict();
export type AutonomyPolicySnapshot = z.infer<
  typeof autonomyPolicySnapshotSchema
>;

export const DEFAULT_AUTONOMY_POLICY: AutonomyPolicy = {
  merge_authority: "cannot_merge",
  work_scope: "issue_only",
  follow_up_issue_authority: "cannot_create",
  review_authority: "request_review_only",
};

const MERGE_TEXT: Readonly<Record<MergeAuthority, string>> = {
  cannot_merge: "cannot merge; manager/project-owner approval required.",
  can_merge_after_gates: "can merge after required gates pass.",
  can_tag_release_after_gates: "can tag/release after required gates pass.",
};

const SCOPE_TEXT: Readonly<Record<WorkScope, string>> = {
  issue_only: "issue-level only.",
  full_dev_sprint: "full-dev mode across the sprint.",
};

const FOLLOW_UP_TEXT: Readonly<Record<FollowUpIssueAuthority, string>> = {
  cannot_create: "cannot create follow-up issues.",
  can_propose:
    "may propose follow-up issues for manager/project-owner approval.",
  can_create: "may create follow-up issues directly.",
};

const REVIEW_TEXT: Readonly<Record<ReviewAuthority, string>> = {
  request_review_only:
    "may request REV/reviewer agents; cannot approve own PR.",
};

export interface AutonomyPolicyChoiceInput {
  readonly mergeAuthority?: string;
  readonly workScope?: string;
  readonly followUpIssueAuthority?: string;
  readonly reviewAuthority?: string;
}

export type ParseAutonomyPolicyChoicesResult =
  | { readonly ok: true; readonly policy: AutonomyPolicy }
  | { readonly ok: false; readonly error: string };

export function readAutonomyPolicyFromConfig(config: unknown): AutonomyPolicy {
  if (
    typeof config !== "object" ||
    config === null ||
    Array.isArray(config) ||
    !("autonomy_policy" in config)
  ) {
    return DEFAULT_AUTONOMY_POLICY;
  }
  const raw = (config as Record<string, unknown>)["autonomy_policy"];
  if (raw === undefined || raw === null) return DEFAULT_AUTONOMY_POLICY;
  return autonomyPolicySchema.parse(raw);
}

export function parseAutonomyPolicyChoices(
  input: AutonomyPolicyChoiceInput,
): ParseAutonomyPolicyChoicesResult {
  const errors: string[] = [];
  const merge_authority = parseChoice(
    "merge authority",
    input.mergeAuthority,
    mergeAuthoritySchema.options,
    DEFAULT_AUTONOMY_POLICY.merge_authority,
    errors,
  );
  const work_scope = parseChoice(
    "work scope",
    input.workScope,
    workScopeSchema.options,
    DEFAULT_AUTONOMY_POLICY.work_scope,
    errors,
  );
  const follow_up_issue_authority = parseChoice(
    "follow-up issue authority",
    input.followUpIssueAuthority,
    followUpIssueAuthoritySchema.options,
    DEFAULT_AUTONOMY_POLICY.follow_up_issue_authority,
    errors,
  );
  const review_authority = parseChoice(
    "review authority",
    input.reviewAuthority,
    reviewAuthoritySchema.options,
    DEFAULT_AUTONOMY_POLICY.review_authority,
    errors,
  );
  if (errors.length > 0) {
    return { ok: false, error: errors.join(" ") };
  }
  return {
    ok: true,
    policy: {
      merge_authority,
      work_scope,
      follow_up_issue_authority,
      review_authority,
    },
  };
}

export function createAutonomyPolicySnapshot(args: {
  readonly policy: AutonomyPolicy;
  readonly recordedAt: string;
  readonly source: AutonomyPolicySnapshot["source"];
}): AutonomyPolicySnapshot {
  return autonomyPolicySnapshotSchema.parse({
    schema_version: AUTONOMY_POLICY_SCHEMA_VERSION,
    policy: args.policy,
    rendered_policy: renderAutonomyPolicyPromptBlock(args.policy),
    recorded_at: args.recordedAt,
    source: args.source,
  });
}

export function renderAutonomyPolicyPromptBlock(
  policy: AutonomyPolicy,
): string {
  const parsed = autonomyPolicySchema.parse(policy);
  return [
    "## Autonomy policy",
    "",
    `- Merge authority: ${MERGE_TEXT[parsed.merge_authority]}`,
    `- Work scope: ${SCOPE_TEXT[parsed.work_scope]}`,
    `- Follow-up issue authority: ${FOLLOW_UP_TEXT[parsed.follow_up_issue_authority]}`,
    `- Review authority: ${REVIEW_TEXT[parsed.review_authority]}`,
  ].join("\n");
}

export function renderAutonomyPolicySnapshotPromptBlock(
  snapshot?: AutonomyPolicySnapshot,
): string {
  if (snapshot === undefined) return "";
  const parsed = autonomyPolicySnapshotSchema.parse(snapshot);
  return `\n\n${parsed.rendered_policy}\n`;
}

function parseChoice<const T extends string>(
  label: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  errors: string[],
): T {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  if (allowed.includes(raw as T)) return raw as T;
  errors.push(
    `Invalid ${label}: ${JSON.stringify(raw)}. Use one of: ${allowed.join(
      ", ",
    )}.`,
  );
  return fallback;
}
