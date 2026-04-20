// Copyright 2026 Nikolay Samokhvalov.

// SPEC §5 Phase 5 + §7 revise semantics — v0.1 draft authoring.
//
// The lead's `revise()` call is the entry point for a full spec write
// (not a patch). For the v0.1 draft we pass:
//   - a minimal scaffold `spec` string that carries the persona, idea,
//     interview Q&A, and a pointer at the untrusted context envelopes
//   - `reviews: []` and `decisions_history: []` (there has been no
//     review round yet)
//   - `effort: "max"` (SPEC §11 product thesis: lead runs at max
//     effort; downshift is an explicit opt-in)
//   - `timeout: 600_000` (SPEC §7 revise default)
//
// Failure classification per SPEC §7 exit-4 messaging:
//   - refusal       -> sub-reason "refusal"
//   - schema-fail   -> sub-reason "schema_fail"
//   - invalid-input -> sub-reason "invalid_input"
//   - budget        -> sub-reason "budget"
//   - wall-clock    -> sub-reason "wall_clock"
// Callers translate `sub_reason` into the canonical copy via
// `formatLeadTerminalMessage`.
//
// Scope guard: this module does NOT write SPEC.md, TLDR.md, or commit.
// It returns the lead's payload; the new/resume flow handles files.

import type { Adapter, EffortLevel, ReviseOutput } from "../adapter/types.ts";
import type { InterviewResult } from "./interview.ts";

// ---------- constants ----------

/** SPEC §7: `revise()` default timeout is 600s. */
export const DRAFT_REVISE_TIMEOUT_MS = 600_000 as const;

/** SPEC §11: lead runs at max effort by default. */
export const DRAFT_DEFAULT_EFFORT: EffortLevel = "max";

// ---------- types ----------

export type LeadTerminalSubReason =
  | "refusal"
  | "schema_fail"
  | "invalid_input"
  | "budget"
  | "wall_clock"
  | "adapter_error";

export class DraftTerminalError extends Error {
  readonly sub_reason: LeadTerminalSubReason;
  readonly detail: string;
  constructor(sub_reason: LeadTerminalSubReason, detail: string) {
    super(`draft lead_terminal: ${sub_reason}: ${detail}`);
    this.name = "DraftTerminalError";
    this.sub_reason = sub_reason;
    this.detail = detail;
  }
}

export interface DraftInput {
  readonly slug: string;
  readonly idea: string;
  readonly persona: string;
  readonly interview: InterviewResult;
  /** Envelope-wrapped context chunks from `discoverContext`. */
  readonly contextChunks: readonly string[];
  readonly explain: boolean;
  readonly effort?: EffortLevel;
  readonly timeoutMs?: number;
}

export interface DraftResult {
  readonly spec: string;
  readonly ready: boolean;
  readonly rationale: string;
  readonly effort_used: EffortLevel;
  readonly usage: ReviseOutput["usage"];
}

// ---------- scaffold prompt ----------

/**
 * Build the `spec` string passed into `revise()`. Even though
 * `revise()` emits the full spec text, the lead still needs the
 * scaffold as the starting point — persona, idea, interview Q&A,
 * context chunks. We keep this assembly deterministic so tests can
 * inspect exactly what the lead saw.
 */
export function buildDraftScaffold(input: DraftInput): string {
  const lines: string[] = [];
  lines.push("# SPEC (v0.1 draft scaffold)");
  lines.push("");
  if (input.explain) {
    lines.push(
      "Audience reminder: plain English throughout. Avoid engineer-terse " +
        "jargon in any user-facing prose fields.",
    );
    lines.push("");
  }
  lines.push(`## Persona`);
  lines.push("");
  lines.push(input.persona);
  lines.push("");
  lines.push(`## Idea`);
  lines.push("");
  lines.push(input.idea);
  lines.push("");
  lines.push(`## Interview`);
  lines.push("");
  for (const q of input.interview.questions) {
    const ans = input.interview.answers.find((a) => a.id === q.id);
    const answerText =
      ans === undefined
        ? "(no answer)"
        : ans.choice === "custom" && typeof ans.custom === "string"
          ? `custom: ${ans.custom}`
          : ans.choice;
    lines.push(`### ${q.id}: ${q.text}`);
    lines.push("");
    lines.push(`answer: ${answerText}`);
    lines.push("");
  }
  if (input.contextChunks.length > 0) {
    lines.push(`## Context`);
    lines.push("");
    for (const chunk of input.contextChunks) {
      lines.push(chunk);
    }
  }
  return lines.join("\n");
}

// ---------- author the draft ----------

/**
 * Call `adapter.revise()` with the scaffold and translate failures
 * into `DraftTerminalError` with a specific `sub_reason`. On success,
 * return a `DraftResult` the caller can write to disk.
 */
export async function authorDraft(
  input: DraftInput,
  adapter: Adapter,
): Promise<DraftResult> {
  const scaffold = buildDraftScaffold(input);
  const effort: EffortLevel = input.effort ?? DRAFT_DEFAULT_EFFORT;
  const timeout = input.timeoutMs ?? DRAFT_REVISE_TIMEOUT_MS;

  let out: ReviseOutput;
  try {
    out = await adapter.revise({
      spec: scaffold,
      reviews: [],
      decisions_history: [],
      opts: { effort, timeout },
    });
  } catch (err) {
    throw classifyReviseError(err);
  }

  // Post-call sanity: a successful response with an empty spec body
  // is treated as schema_fail. The adapter already zod-validates
  // `ReviseOutputSchema`, which requires `spec: min(1)` — this guard
  // is a belt-and-braces defense against future schema drift.
  if (out.spec.trim().length === 0) {
    throw new DraftTerminalError(
      "schema_fail",
      "adapter returned empty spec body",
    );
  }

  return {
    spec: out.spec,
    ready: out.ready,
    rationale: out.rationale,
    effort_used: out.effort_used,
    usage: out.usage,
  };
}

function classifyReviseError(err: unknown): DraftTerminalError {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const lower = message.toLowerCase();
  if (lower.includes("refus")) {
    return new DraftTerminalError("refusal", message);
  }
  if (lower.includes("schema")) {
    return new DraftTerminalError("schema_fail", message);
  }
  if (lower.includes("invalid input") || lower.includes("too large")) {
    return new DraftTerminalError("invalid_input", message);
  }
  if (lower.includes("budget")) {
    return new DraftTerminalError("budget", message);
  }
  if (lower.includes("wall-clock") || lower.includes("wall clock")) {
    return new DraftTerminalError("wall_clock", message);
  }
  return new DraftTerminalError("adapter_error", message);
}

// ---------- SPEC §7 exit-4 messaging table ----------

/**
 * Canonical exit-4 copy per SPEC §7 for each sub-reason. Callers
 * print this message to stderr alongside the state-persistence notice.
 */
export function formatLeadTerminalMessage(
  slug: string,
  sub: LeadTerminalSubReason,
  detail: string,
): string {
  const detailSuffix = detail.length > 0 ? ` (${detail})` : "";
  switch (sub) {
    case "refusal":
      return (
        `samospec: lead_terminal — model refused. ` +
        `Edit .samospec/spec/${slug}/SPEC.md to remove sensitive content ` +
        `or retry.${detailSuffix}`
      );
    case "schema_fail":
      return (
        `samospec: lead_terminal — adapter returned invalid structured output. ` +
        `File a samospec bug or switch adapter.${detailSuffix}`
      );
    case "invalid_input":
      return (
        `samospec: lead_terminal — spec too large or malformed. ` +
        `Check .samospec/spec/${slug}/SPEC.md.${detailSuffix}`
      );
    case "budget":
      return (
        `samospec: lead_terminal — budget cap hit. ` +
        `Downshift via --effort or raise budget.*.${detailSuffix}`
      );
    case "wall_clock":
      return (
        `samospec: lead_terminal — session wall-clock hit. ` +
        `Resume to continue.${detailSuffix}`
      );
    case "adapter_error":
      return (
        `samospec: lead_terminal — adapter error. ` +
        `See .samospec/spec/${slug}/ for state and retry.${detailSuffix}`
      );
  }
}
