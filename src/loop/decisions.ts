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

import type { Finding, FindingCategory } from "../adapter/types.ts";

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
export function appendRoundDecisions(
  input: AppendRoundDecisionsInput,
): string {
  const header = `## Round ${String(input.roundNumber)} — ${input.now}`;
  const lines: string[] = [];
  if (!existsSync(input.file)) {
    // Seed header only; skip the "populated during Sprint 3" placeholder
    // because we *are* populating it.
    writeFileSync(
      input.file,
      ["# decisions", ""].join("\n"),
      "utf8",
    );
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
