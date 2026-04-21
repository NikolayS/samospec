// Copyright 2026 Nikolay Samokhvalov.

// SPEC §3 (claim 1 — persona-orthogonal), §7 (Model roles), §11
// (coupled_fallback): the Reviewer B adapter — a Claude second-session
// wrapper over the lead ClaudeAdapter. Same vendor, same model pin,
// different persona.
//
// Design note: this is a **thin compose-over-inherit** wrapper. The
// class extends ClaudeAdapter so it shares the full spawn, JSON-parse,
// timeout, and error-classification plumbing without duplication. The
// only functional override is `critique()`, which prepends the literal
// taxonomy-weighting prefix from SPEC §7 to the caller's guidelines.
// `ask()` and `revise()` delegate to the inherited implementations
// unchanged — Reviewer B is a reviewer seat, but keeping the full
// Adapter surface live lets it pass the shared contract test.
//
// Separation of processes (SPEC §7 "separate session from lead"):
// Each Bun.spawn invocation from `ClaudeReviewerBAdapter.critique()`
// is an entirely separate subprocess from the lead's spawns — because
// the wrapper itself spawns via `super.critique() -> this.spawnOnce()`,
// which issues its own `Bun.spawn` call each time.
//
// Shared resolver (SPEC §11 coupled fallback): both lead and Reviewer
// B are constructed with a reference to the same `ClaudeResolver`
// instance (see `./claude-resolver.ts`). When the lead advances the
// resolver on a model-unavailable failure, Reviewer B's very next
// spawn picks up the new pin automatically.
//
// v0.4.0 (#85): when CritiqueInput carries an `idea` string, Reviewer B
// receives an explicit contradiction-detection directive: flag any spec
// section that reintroduces a class the idea disclaimed. The idea is
// prepended to the guidelines via `buildCritiquePromptForReviewerB` so
// the model sees it before the spec text.

import {
  ClaudeAdapter,
  buildCritiquePrompt,
  type ClaudeAdapterOpts,
} from "./claude.ts";
import { type CritiqueInput, type CritiqueOutput } from "./types.ts";

// SPEC §7: literal persona prefix applied to Reviewer B critique()
// calls. The wording is fixed — spec compliance is verified in tests.
//
// v0.2.0 addition: Reviewer B explicitly checks for missing baseline
// sections (SPEC §7 baseline section template) and raises
// `missing-requirement` findings when any mandatory section is absent.
export const REVIEWER_B_PERSONA_PREFIX =
  "Focus especially on ambiguity, contradiction, and weak-testing. " +
  "You may surface findings in other categories when warranted, but " +
  "weight your effort toward these. " +
  "Additionally, check that the spec includes all nine mandatory baseline " +
  "sections: (1) version header, (2) goal & why it's needed, " +
  "(3) user stories (≥3 with persona+action+outcome), (4) architecture, " +
  "(5) implementation details, (6) tests plan with red/green TDD call-out, " +
  "(7) team of veteran experts (count + skill labels), " +
  "(8) implementation plan with sprints + parallelization, " +
  "(9) embedded changelog. " +
  "Raise a missing-requirement finding for each absent mandatory section.";

// v0.4.0 (#85): when an idea string is present, Reviewer B carries this
// contradiction-detection directive verbatim before the guidelines.
// Exported so tests can assert on the literal wording.
export const REVIEWER_B_CONTRADICTION_DIRECTIVE =
  "IDEA-CONTRADICTION CHECK: The user's original idea is provided below " +
  "under '## Original idea'. If the idea contains explicit disclaimers " +
  "(e.g. 'NOT X', 'not a Y', 'this is NOT a Z'), carefully read every " +
  "section of the spec and flag any section that reintroduces the disclaimed " +
  "class as a `contradiction` finding (severity: major). Quote the exact " +
  "disclaimer from the idea and the offending spec section text in the " +
  "finding's `text` field.";

/**
 * Build the full critique prompt for Reviewer B, incorporating:
 * 1. The persona prefix (taxonomy weighting + baseline section check).
 * 2. If `input.idea` is present: the contradiction-detection directive
 *    + the idea string under a labelled header.
 * 3. The caller's guidelines (if any).
 * 4. The standard critique prompt structure (schema + spec text).
 *
 * Exported so tests can inspect the assembled prompt without spawning.
 */
export function buildCritiquePromptForReviewerB(input: CritiqueInput): string {
  // Build the composed guidelines = persona + optional idea-contradiction
  // directive + caller guidelines.
  const ideaSection =
    input.idea !== undefined && input.idea.trim().length > 0
      ? `${REVIEWER_B_CONTRADICTION_DIRECTIVE}\n\n## Original idea\n${input.idea}\n`
      : "";

  const composedGuidelines = [
    REVIEWER_B_PERSONA_PREFIX,
    ideaSection,
    input.guidelines,
  ]
    .filter((s) => s.trim().length > 0)
    .join("\n\n");

  // Build using the same base prompt builder so schema + spec text are
  // identical to what the plain ClaudeAdapter would produce.
  return buildCritiquePrompt({ ...input, guidelines: composedGuidelines });
}

// ---------- ClaudeReviewerBAdapter ----------

export class ClaudeReviewerBAdapter extends ClaudeAdapter {
  // Distinct vendor tag is unnecessary — Reviewer B uses the Claude
  // CLI identically to the lead. Contract tests and the `doctor` layer
  // key on vendor, and both seats appropriately report "claude".

  constructor(opts: ClaudeAdapterOpts = {}) {
    super(opts);
  }

  override critique(input: CritiqueInput): Promise<CritiqueOutput> {
    // v0.4.0 (#85): use buildCritiquePromptForReviewerB which injects
    // the persona prefix + optional idea-contradiction directive. We
    // override the inherited critique() by reconstructing the input with
    // pre-composed guidelines so super.critique() sees the full prompt.
    //
    // We call super.critique() with the composed guidelines so the
    // inherited spawn + JSON-parse + retry plumbing runs unchanged.
    const composedGuidelines = [
      REVIEWER_B_PERSONA_PREFIX,
      input.idea !== undefined && input.idea.trim().length > 0
        ? `${REVIEWER_B_CONTRADICTION_DIRECTIVE}\n\n## Original idea\n${input.idea}`
        : "",
      input.guidelines,
    ]
      .filter((s) => s.trim().length > 0)
      .join("\n\n");

    const withPersona: CritiqueInput = {
      ...input,
      guidelines: composedGuidelines,
    };
    return super.critique(withPersona);
  }
}
