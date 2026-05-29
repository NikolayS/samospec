// Copyright 2026 Nikolay Samokhvalov.

/**
 * Reviewer context preservation across review rounds.
 *
 * THE PROBLEM: each reviewer seat is called every round with ONLY the
 * current spec (`CritiqueInput`). The adapters spawn one-shot
 * `claude --print` / `codex exec` subprocesses with no session memory,
 * and the lead's `decisions.md` is fed to the LEAD's revise(), never to
 * the reviewers. So every round each reviewer reviews cold — it re-raises
 * findings the lead already consciously deferred/rejected and re-discovers
 * issues, making the major count oscillate instead of converging.
 *
 * THE FIX: before calling a reviewer's `critique()` on round N>1,
 * reconstruct that reviewer's prior context from PERSISTED artifacts and
 * pass it as `CritiqueInput.prior_context`:
 *
 *   1. That reviewer's OWN prior critiques across rounds — reviewer A
 *      (codex) reads `reviews/rNN/codex.md`; reviewer B (claude) reads
 *      `reviews/rNN/claude.md`. Each seat sees ONLY its own findings.
 *   2. The lead's per-finding rulings from `decisions.md` (accepted /
 *      rejected / deferred + rationale) so the reviewer can see how the
 *      lead responded.
 *
 * Because the context is rebuilt from on-disk artifacts (not a live
 * session), it AUTOMATICALLY survives `resume`: a resumed run reads the
 * same files and reconstructs the same block. Missing / partial /
 * unparseable files degrade gracefully to no prior context (round-1
 * behavior).
 *
 * Boundedness: only the last {@link PRIOR_CONTEXT_MAX_ROUNDS} rounds are
 * summarized, and the whole block is truncated to
 * {@link PRIOR_CONTEXT_MAX_CHARS} so the prompt doesn't grow unboundedly
 * across a long review.
 */

import { existsSync, readFileSync } from "node:fs";

import type { Finding } from "../adapter/types.ts";
import {
  type ReviewerSeat,
  recoverCritiqueFromFile,
  roundDirsFor,
} from "./round.ts";

/**
 * How many of the most-recent prior rounds to summarize into a reviewer's
 * prior context. Older rounds are dropped to bound prompt growth — by the
 * time a finding is several rounds old it has either been resolved or the
 * lead has ruled on it (which the decisions.md excerpt still surfaces).
 */
export const PRIOR_CONTEXT_MAX_ROUNDS = 3 as const;

/**
 * Hard character cap on the rendered prior-context block. The block is
 * truncated (with an explicit notice) if reconstruction exceeds this, so
 * a pathological round of huge findings can't blow up the critique prompt.
 */
export const PRIOR_CONTEXT_MAX_CHARS = 8_000 as const;

/**
 * Sub-budget (chars) reserved for the lead-decisions section so it
 * SURVIVES truncation. Convergence depends on each reviewer seeing the
 * lead's recent deferred/rejected rulings; before samospec #180 FIX 2 the
 * decisions section was appended LAST and the head-only cap sliced it off
 * the moment a seat's own prior findings filled the budget. We now cap
 * findings to `PRIOR_CONTEXT_MAX_CHARS - PRIOR_CONTEXT_DECISIONS_RESERVE`
 * and the decisions section to this reserve (keeping its TAIL, where the
 * most-recent rulings live), and emit decisions BEFORE findings.
 */
export const PRIOR_CONTEXT_DECISIONS_RESERVE = 3_000 as const;

/**
 * The convergence instruction the reviewer critique prompt builders
 * prepend to a present prior-context block. Kept here (not in the
 * adapters) so the wording lives next to the context reconstruction it
 * frames, and so the prompt builders + tests share one source of truth.
 * `buildPriorContext` deliberately does NOT embed this — the prompt
 * builders wrap the reconstructed data with it via
 * `renderPriorContextPromptBlock`, so the instruction appears exactly
 * once whether or not prior data was recoverable.
 */
export const CONVERGENCE_INSTRUCTION =
  "You reviewed earlier versions of this spec. Below are the findings " +
  "YOU raised before and how the lead responded. Verify whether each " +
  "prior finding is now RESOLVED in the current spec; do NOT re-raise a " +
  "finding the lead consciously deferred or rejected WITH a rationale " +
  "unless it has regressed or you have genuinely new evidence. " +
  "Concentrate on new or still-unresolved issues. Your job across rounds " +
  "is to drive toward convergence, not to restate prior findings.";

export interface BuildPriorContextInput {
  /** Absolute path to the spec slug dir (`<spec_dir>/<slug>`). */
  readonly slugDir: string;
  /** The round about to run (1-based). Prior rounds are `< currentRound`. */
  readonly currentRound: number;
  /** Which reviewer seat the context is for (selects codex.md vs claude.md). */
  readonly seat: ReviewerSeat;
}

/**
 * Render one finding into a compact bullet for the prior-context block.
 */
function renderFinding(f: Finding): string {
  return `- (${f.severity}/${f.category}) ${f.text}`;
}

/**
 * Read this seat's own persisted critique for a given round and return its
 * rendered findings bullets, or null when the file is missing/unparseable.
 */
function priorFindingsForRound(
  slugDir: string,
  round: number,
  seat: ReviewerSeat,
): string | null {
  const dirs = roundDirsFor(slugDir, round);
  const file = seat === "reviewer_a" ? dirs.codexPath : dirs.claudePath;
  const critique = recoverCritiqueFromFile(file);
  if (critique === null || critique.findings.length === 0) return null;
  const bullets = critique.findings.map(renderFinding).join("\n");
  return bullets;
}

/**
 * Read decisions.md (if present) and return its body, trimmed. Returns the
 * empty string when the file is absent or empty. Degrades silently on any
 * read error so a corrupt decisions file never crashes the round.
 */
function readDecisionsExcerpt(slugDir: string): string {
  // decisions.md lives directly in the slug dir, next to SPEC.md.
  const file = `${slugDir}/decisions.md`;
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Build a reviewer's prior context from persisted artifacts.
 *
 * Returns `undefined` when there is nothing to carry forward:
 *   - round 1 (no prior rounds), OR
 *   - none of the prior rounds have a recoverable critique for this seat
 *     AND there are no recorded decisions.
 *
 * Never throws: every filesystem touch degrades to "absent".
 */
export function buildPriorContext(
  input: BuildPriorContextInput,
): string | undefined {
  const { slugDir, currentRound, seat } = input;
  if (currentRound <= 1) return undefined;

  // Window: the last PRIOR_CONTEXT_MAX_ROUNDS rounds strictly before the
  // current one. Walk newest -> oldest so truncation drops the oldest.
  const newest = currentRound - 1;
  const oldest = Math.max(1, newest - PRIOR_CONTEXT_MAX_ROUNDS + 1);

  const roundSections: string[] = [];
  for (let r = newest; r >= oldest; r -= 1) {
    const bullets = priorFindingsForRound(slugDir, r, seat);
    if (bullets === null) continue;
    roundSections.push(`#### Round ${String(r)}\n${bullets}`);
  }

  const decisionsExcerpt = readDecisionsExcerpt(slugDir);

  // Nothing recoverable for this seat and no decisions → behave like
  // round 1 (no prior context).
  if (roundSections.length === 0 && decisionsExcerpt.length === 0) {
    return undefined;
  }

  // FIX 2 (samospec #180): the lead's recent rulings drive convergence,
  // so guarantee the decisions section survives truncation. We cap the
  // decisions section to a reserved sub-budget (keeping its TAIL — the
  // most-recent rulings) and the findings section to whatever remains,
  // then emit DECISIONS FIRST so head-truncation can never drop them.
  const parts: string[] = [];

  let decisionsReserve = 0;
  if (decisionsExcerpt.length > 0) {
    const decisionsSection = capDecisionsSection(
      `### Lead decisions on prior findings\n${decisionsExcerpt}`,
    );
    parts.push(decisionsSection);
    decisionsReserve = decisionsSection.length;
  }

  if (roundSections.length > 0) {
    parts.push(`### Your prior findings\n${roundSections.join("\n\n")}`);
  }

  const block = parts.join("\n\n");
  // The findings tail (everything after the reserved decisions section)
  // absorbs any remaining truncation. Reserve the decisions length so the
  // head cap never eats into it.
  return capBlock(block, decisionsReserve);
}

/**
 * Cap the lead-decisions section to {@link PRIOR_CONTEXT_DECISIONS_RESERVE}
 * chars, keeping the TAIL (most-recent rulings — decisions.md appends
 * newest last) and re-prefixing the section heading so the reviewer can
 * still find it. Returns the section unchanged when it already fits.
 */
function capDecisionsSection(section: string): string {
  if (section.length <= PRIOR_CONTEXT_DECISIONS_RESERVE) return section;
  const heading = "### Lead decisions on prior findings\n";
  const notice = "[older lead decisions truncated; most recent kept]\n";
  const tailBudget = Math.max(
    0,
    PRIOR_CONTEXT_DECISIONS_RESERVE - heading.length - notice.length,
  );
  const body = section.slice(heading.length);
  const tail = body.slice(Math.max(0, body.length - tailBudget));
  return `${heading}${notice}${tail}`;
}

/**
 * Wrap a reconstructed prior-context block for injection into a reviewer's
 * critique prompt. Returns the empty string when there is no prior context
 * (round 1 / nothing recoverable) so the prompt is byte-identical to the
 * pre-feature behavior. When present, the block is framed by the
 * {@link CONVERGENCE_INSTRUCTION} so the reviewer is told exactly how to
 * use its own history (verify resolution, don't re-raise consciously
 * deferred/rejected findings, concentrate on new/unresolved issues).
 *
 * Shared by both reviewer adapters (codex / claude) so the framing is
 * identical for Reviewer A and Reviewer B.
 */
export function renderPriorContextPromptBlock(
  priorContext: string | undefined,
): string {
  if (priorContext === undefined || priorContext.trim().length === 0) {
    return "";
  }
  return `\n\n## Your prior review context\n${CONVERGENCE_INSTRUCTION}\n\n${priorContext}`;
}

/**
 * Truncate the rendered block to PRIOR_CONTEXT_MAX_CHARS, keeping the head
 * and appending an explicit truncation notice. The notice is itself
 * counted so the returned string never exceeds the cap.
 *
 * The convergence instruction is NOT in this block — it is prepended later
 * by {@link renderPriorContextPromptBlock}, so it is never at risk of
 * truncation here. The head of `block` is the lead-decisions section
 * (emitted first by {@link buildPriorContext}); `reservedHead` is its
 * length, and truncation only ever trims the findings tail beyond it, so
 * the decisions section always survives (samospec #180 FIX 2).
 */
function capBlock(block: string, reservedHead = 0): string {
  if (block.length <= PRIOR_CONTEXT_MAX_CHARS) return block;
  const notice = "\n\n[prior context truncated to fit the prompt budget]";
  // Never cut into the reserved (decisions) head; the findings tail
  // absorbs the truncation.
  const headBudget = Math.max(
    reservedHead,
    PRIOR_CONTEXT_MAX_CHARS - notice.length,
  );
  return block.slice(0, headBudget) + notice;
}
