// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §7 — per-finding decisions append to `decisions.md`.
 *
 * The lead emits decisions on `revise()` as part of the structured
 * response. Each decision references a finding (by seat + ordinal for
 * the current round) with a verdict: `accepted` / `rejected` / `deferred`
 * + rationale. We append a Markdown section per round.
 *
 * This module does NOT spawn a model, write state.json, or touch git.
 * It just:
 *   - summarizes a list of findings (for changelog),
 *   - counts decisions,
 *   - appends a round section to `decisions.md` (creating the file if
 *     missing).
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { z } from "zod";

import type {
  Finding,
  FindingCategory,
  ReviseDecision,
} from "../adapter/types.ts";

export const ReviewDecisionSchema = z.object({
  finding_ref: z.string().min(1),
  decision: z.enum(["accepted", "rejected", "deferred"]),
  rationale: z.string().min(1),
});
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export interface FindingsSummary {
  readonly total: number;
  readonly byCategory: ReadonlyMap<FindingCategory, number>;
}

export function summarizeFindings(
  findings: readonly Finding[],
): FindingsSummary {
  const byCategory = new Map<FindingCategory, number>();
  for (const f of findings) {
    byCategory.set(f.category, (byCategory.get(f.category) ?? 0) + 1);
  }
  return { total: findings.length, byCategory };
}

export interface DecisionCounts {
  readonly accepted: number;
  readonly rejected: number;
  readonly deferred: number;
}

export function countDecisions(
  decisions: readonly ReviewDecision[],
): DecisionCounts {
  let accepted = 0;
  let rejected = 0;
  let deferred = 0;
  for (const d of decisions) {
    if (d.decision === "accepted") accepted += 1;
    else if (d.decision === "rejected") rejected += 1;
    else deferred += 1;
  }
  return { accepted, rejected, deferred };
}

export interface AppendRoundDecisionsInput {
  readonly file: string;
  readonly roundNumber: number;
  readonly now: string;
  readonly entries: readonly ReviewDecision[];
}

/**
 * Append a round section to decisions.md. Creates the file if missing.
 * Returns the header line we wrote (useful for unit-test assertions).
 */
export function appendRoundDecisions(input: AppendRoundDecisionsInput): string {
  const header = `## Round ${String(input.roundNumber)} — ${input.now}`;
  const lines: string[] = [];
  if (!existsSync(input.file)) {
    // Seed header only; skip the "populated during Sprint 3" placeholder
    // because we *are* populating it.
    writeFileSync(input.file, ["# decisions", ""].join("\n"), "utf8");
  }
  lines.push("");
  lines.push(header);
  lines.push("");
  if (input.entries.length === 0) {
    lines.push("- no decisions recorded this round");
  } else {
    for (const e of input.entries) {
      const parsed = ReviewDecisionSchema.safeParse(e);
      if (!parsed.success) continue;
      lines.push(
        `- ${parsed.data.decision} ${parsed.data.finding_ref}: ${parsed.data.rationale}`,
      );
    }
  }
  lines.push("");
  appendFileSync(input.file, lines.join("\n"), "utf8");
  return header;
}

/**
 * Convert a ReviseOutput.decisions array (v0.2.0+) to ReviewDecision[]
 * compatible with appendRoundDecisions. When decisions is absent or empty,
 * returns [] which triggers the "no decisions recorded" fallback.
 *
 * Finding-ID substitution (fix for #95): the lead frequently omits
 * `finding_id` from its decision objects, which previously left a
 * literal `#?` placeholder in decisions.md. We now assign a
 * deterministic category-scoped counter (e.g. `ambiguity#1`,
 * `ambiguity#2`) when `finding_id` is missing. Numbering resets per
 * call (so per revise/round) and advances in decision-array order, so
 * the N-th missing-ID decision in category C within a round is
 * stably labelled `C#N`. Entries that DO carry an explicit
 * `finding_id` are passed through verbatim.
 */
export function reviseDecisionsToReviewDecisions(
  decisions: readonly ReviseDecision[] | undefined | null,
): ReviewDecision[] {
  if (decisions === undefined || decisions === null || decisions.length === 0) {
    return [];
  }
  const categoryCounters = new Map<string, number>();
  return decisions.map((d) => {
    let finding_ref: string;
    if (typeof d.finding_id === "string" && d.finding_id.length > 0) {
      finding_ref = d.finding_id;
    } else {
      const next = (categoryCounters.get(d.category) ?? 0) + 1;
      categoryCounters.set(d.category, next);
      finding_ref = `${d.category}#${String(next)}`;
    }
    return {
      finding_ref,
      decision: d.verdict,
      rationale: d.rationale,
    };
  });
}

/** Seed a fresh decisions.md when the new flow didn't write one. */
export function ensureDecisionsFile(file: string): void {
  if (existsSync(file)) return;
  writeFileSync(
    file,
    ["# decisions", "", "- populated by the review loop", ""].join("\n"),
    "utf8",
  );
}

/** Read a decisions.md file; returns [] on miss. */
export function readDecisionsFile(file: string): string {
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8");
}

// Used by the iterate CLI's revise prompt: a compact schema description
// the lead reads before emitting the structured `decisions` array.
export function buildDecisionSchemaLines(): readonly string[] {
  return [
    "Each decision object has:",
    "- finding_ref: the seat + ordinal, e.g. 'codex#1' or 'claude#2'",
    "- decision: one of accepted | rejected | deferred",
    "- rationale: one-sentence reason for the decision",
  ];
}
