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

import { ClaudeAdapter, type ClaudeAdapterOpts } from "./claude.ts";
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

// ---------- ClaudeReviewerBAdapter ----------

export class ClaudeReviewerBAdapter extends ClaudeAdapter {
  // Distinct vendor tag is unnecessary — Reviewer B uses the Claude
  // CLI identically to the lead. Contract tests and the `doctor` layer
  // key on vendor, and both seats appropriately report "claude".

  constructor(opts: ClaudeAdapterOpts = {}) {
    super(opts);
  }

  override critique(input: CritiqueInput): Promise<CritiqueOutput> {
    // Prepend the persona prefix to the caller's guidelines so the
    // system-level taxonomy weighting is the first thing the model
    // reads. The inner ClaudeAdapter.critique() then builds the usual
    // critique prompt around this composed guideline string.
    const composedGuidelines =
      input.guidelines === ""
        ? REVIEWER_B_PERSONA_PREFIX
        : `${REVIEWER_B_PERSONA_PREFIX}\n\n${input.guidelines}`;
    const withPersona: CritiqueInput = {
      ...input,
      guidelines: composedGuidelines,
    };
    return super.critique(withPersona);
  }
}
