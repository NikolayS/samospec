// Copyright 2026 Nikolay Samokhvalov.

import { z } from "zod";

// SPEC §5 — eight phases in canonical order.
export const PHASES = [
  "detect",
  "branch_lock_preflight",
  "persona",
  "context",
  "interview",
  "draft",
  "review_loop",
  "publish",
] as const;
export type Phase = (typeof PHASES)[number];
export const phaseSchema = z.enum(PHASES);

// SPEC §7 — six round states including lead_terminal.
export const ROUND_STATES = [
  "planned",
  "running",
  "reviews_collected",
  "lead_revised",
  "committed",
  "lead_terminal",
] as const;
export type RoundState = (typeof ROUND_STATES)[number];
export const roundStateSchema = z.enum(ROUND_STATES);

// SPEC §7 — reviewer seat status set.
export const SEAT_STATES = [
  "pending",
  "ok",
  "failed",
  "schema_violation",
  "timeout",
] as const;
export type SeatState = (typeof SEAT_STATES)[number];
export const seatStateSchema = z.enum(SEAT_STATES);

// SPEC §7 — round.json top-level status set.
export const ROUND_STATUSES = [
  "planned",
  "running",
  "complete",
  "partial",
  "abandoned",
] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];
export const roundStatusSchema = z.enum(ROUND_STATUSES);

// ISO 8601 timestamp ending in Z. Kept narrow so malformed writes are caught.
const isoTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/,
    "must be an ISO 8601 UTC timestamp ending in 'Z'",
  );

// SemVer, SPEC uses `X.Y.Z` version format (no pre-release tags for now).
const semverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "must match X.Y.Z SemVer");

// SPEC §8 — HEAD sha recorded on each state.json write so remote
// reconciliation can halt on drift. Full 40-char lowercase hex only.
const headShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be a 40-char lowercase hex sha");

const personaSchema = z
  .object({
    skill: z.string().min(1),
    accepted: z.boolean(),
  })
  .strict();

const calibrationSchema = z
  .object({
    // Per SPEC §11: preflight coefficients tightened from prior runs.
    prior_runs: z.number().int().nonnegative(),
    midpoint_usd: z.number().nonnegative(),
  })
  .strict();

const pushConsentSchema = z
  .object({
    remote: z.string().min(1),
    granted: z.boolean(),
    recorded_at: isoTimestampSchema,
  })
  .strict();

// SPEC §12 — exit is recorded with reason string and round_index.
const exitSchema = z
  .object({
    code: z.number().int().nonnegative(),
    reason: z.string().min(1),
    round_index: z.number().int().nonnegative(),
  })
  .strict();

// SPEC §7 + §11 — resolved adapter snapshot recorded at round start.
const adapterResolutionSchema = z
  .object({
    adapter: z.string().min(1),
    model_id: z.string().min(1),
    effort_requested: z.string().min(1),
    effort_used: z.string().min(1),
  })
  .strict();

// SPEC §5 Phase 7 + Issue #32 — label like `v0.2`, `v1.3.1`.
const publishedVersionSchema = z
  .string()
  .regex(
    /^v\d+\.\d+(?:\.\d+)?$/,
    "published_version must look like 'vX.Y' or 'vX.Y.Z'",
  );

export const stateSchema = z
  .object({
    slug: z.string().min(1),
    phase: phaseSchema,
    round_index: z.number().int().nonnegative(),
    version: semverSchema,
    persona: personaSchema.nullable(),
    push_consent: pushConsentSchema.nullable(),
    calibration: calibrationSchema.nullable(),
    remote_stale: z.boolean(),
    coupled_fallback: z.boolean(),
    head_sha: headShaSchema.nullable().optional(),
    round_state: roundStateSchema,
    exit: exitSchema.nullable(),
    adapters: z
      .object({
        lead: adapterResolutionSchema,
        reviewer_a: adapterResolutionSchema,
        reviewer_b: adapterResolutionSchema,
      })
      .partial()
      .strict()
      .optional(),
    // SPEC §5 Phase 7 + Issue #32 — `samospec publish` advance.
    published_at: isoTimestampSchema.optional(),
    published_version: publishedVersionSchema.optional(),
    /** Absent when neither `gh` nor `glab` was authenticated; set from
     * the tool's stdout URL when the PR was opened successfully. */
    published_pr_url: z.string().min(1).optional(),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
    /**
     * #85 (v0.4.0): original user inputs recorded at `samospec new` time
     * so subsequent commands (iterate, resume) can thread the idea string
     * into prompt builders without requiring re-supply on the CLI.
     */
    input: z
      .object({
        /** Original --idea string (AUTHORITATIVE per SPEC §7 v0.4.0). */
        idea: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type State = z.infer<typeof stateSchema>;

export const roundSchema = z
  .object({
    round: z.number().int().positive(),
    status: roundStatusSchema,
    seats: z
      .object({
        reviewer_a: seatStateSchema,
        reviewer_b: seatStateSchema,
      })
      .strict(),
    started_at: isoTimestampSchema,
    completed_at: isoTimestampSchema.optional(),
  })
  .strict();

export type Round = z.infer<typeof roundSchema>;

export const lockSchema = z
  .object({
    pid: z.number().int().positive(),
    started_at: isoTimestampSchema,
    slug: z.string().min(1),
  })
  .strict();

export type Lock = z.infer<typeof lockSchema>;
