// Copyright 2026 Nikolay Samokhvalov.

import { z } from "zod";

// SPEC §7: adapter contract. Effort ladder per SPEC §11.
export const EffortLevelSchema = z.enum([
  "max",
  "high",
  "medium",
  "low",
  "off",
]);
export type EffortLevel = z.infer<typeof EffortLevelSchema>;

// Positive integer milliseconds. Callers choose per-call default.
const PositiveIntMs = z
  .number()
  .int({ message: "timeout must be an integer (ms)" })
  .positive({ message: "timeout must be > 0" });

export const WorkOptsSchema = z.object({
  effort: EffortLevelSchema,
  timeout: PositiveIntMs,
});
export type WorkOpts = z.infer<typeof WorkOptsSchema>;

// `usage: null` per SPEC §7 / §11 — adapter cannot report token/cost.
export const UsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cost_usd: z.number().nonnegative().optional(),
  })
  .nullable();
export type Usage = z.infer<typeof UsageSchema>;

export const DetectResultSchema = z.discriminatedUnion("installed", [
  z.object({
    installed: z.literal(true),
    version: z.string().min(1),
    path: z.string().min(1),
  }),
  z.object({
    installed: z.literal(false),
  }),
]);
export type DetectResult = z.infer<typeof DetectResultSchema>;

// SPEC §7 auth lifecycle + §11 subscription-auth escape.
export const AuthStatusSchema = z.object({
  authenticated: z.boolean(),
  account: z.string().optional(),
  expires_at: z.string().optional(),
  subscription_auth: z.boolean().optional(),
});
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

export const ModelInfoSchema = z.object({
  id: z.string().min(1),
  family: z.string().min(1),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

// ---------- Work outputs ----------

export const AskInputSchema = z.object({
  prompt: z.string().min(1),
  context: z.string(),
  opts: WorkOptsSchema,
});
export type AskInput = z.infer<typeof AskInputSchema>;

export const AskOutputSchema = z.object({
  answer: z.string(),
  usage: UsageSchema,
  effort_used: EffortLevelSchema,
});
export type AskOutput = z.infer<typeof AskOutputSchema>;

// SPEC §7 review taxonomy.
export const FindingCategorySchema = z.enum([
  "ambiguity",
  "contradiction",
  "missing-requirement",
  "weak-testing",
  "weak-implementation",
  "missing-risk",
  "unnecessary-scope",
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

export const FindingSeveritySchema = z.enum(["major", "minor"]);

export const FindingSchema = z.object({
  category: FindingCategorySchema,
  text: z.string().min(1),
  severity: FindingSeveritySchema,
});
export type Finding = z.infer<typeof FindingSchema>;

export const CritiqueInputSchema = z.object({
  spec: z.string().min(1),
  guidelines: z.string(),
  opts: WorkOptsSchema,
});
export type CritiqueInput = z.infer<typeof CritiqueInputSchema>;

export const CritiqueOutputSchema = z.object({
  findings: z.array(FindingSchema),
  summary: z.string(),
  suggested_next_version: z.string().min(1),
  usage: UsageSchema,
  effort_used: EffortLevelSchema,
});
export type CritiqueOutput = z.infer<typeof CritiqueOutputSchema>;

export const DecisionSchema = z.object({
  finding_ref: z.string(),
  decision: z.enum(["accepted", "rejected", "deferred"]),
  rationale: z.string(),
});

export const ReviseInputSchema = z.object({
  spec: z.string().min(1),
  reviews: z.array(CritiqueOutputSchema),
  decisions_history: z.array(DecisionSchema),
  opts: WorkOptsSchema,
});
export type ReviseInput = z.infer<typeof ReviseInputSchema>;

// Lead-ready protocol: `ready` + `rationale` inline on revise().
export const ReviseOutputSchema = z.object({
  spec: z.string().min(1),
  ready: z.boolean(),
  rationale: z.string(),
  usage: UsageSchema,
  effort_used: EffortLevelSchema,
});
export type ReviseOutput = z.infer<typeof ReviseOutputSchema>;

// ---------- Adapter interface ----------

export interface Adapter {
  /** Vendor short name ("claude" | "codex" | ...). Used by doctor / policy. */
  readonly vendor: string;

  // Lifecycle
  detect(): Promise<DetectResult>;
  auth_status(): Promise<AuthStatus>;
  supports_structured_output(): boolean;
  supports_effort(level: EffortLevel): boolean;
  models(): Promise<readonly ModelInfo[]>;

  // Work
  ask(input: AskInput): Promise<AskOutput>;
  critique(input: CritiqueInput): Promise<CritiqueOutput>;
  revise(input: ReviseInput): Promise<ReviseOutput>;
}
