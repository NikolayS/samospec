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
export const REVIEWER_B_PERSONA_PREFIX =
  "Focus especially on ambiguity, contradiction, and weak-testing. " +
  "You may surface findings in other categories when warranted, but " +
  "weight your effort toward these.";

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
