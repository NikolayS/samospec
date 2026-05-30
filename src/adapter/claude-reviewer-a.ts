// Copyright 2026 Nikolay Samokhvalov.

// SPEC §7 (Model roles), §11 (coupled_fallback): a Claude-vendor
// Reviewer A adapter — a Claude session wrapping the lead ClaudeAdapter
// that carries the SECURITY/OPS persona normally owned by the Codex
// Reviewer A seat. Same vendor + plumbing as the lead and Reviewer B,
// different persona.
//
// Why this exists: the Reviewer A seat is configurable per seat via
// `adapters.reviewer_a.adapter` in `.samo/config.json`. The default is
// `codex` (unchanged), but Claude-only environments (no `codex` CLI)
// can set it to `claude` and still get a paranoid security/ops reviewer.
// This class preserves persona parity with the Codex Reviewer A: it
// prepends the SAME literal persona prefix exported from `codex.ts`
// (`CODEX_CRITIQUE_PERSONA_PREFIX`) so the taxonomy weighting toward
// missing-risk / weak-implementation / unnecessary-scope is identical
// regardless of which vendor fills the seat.
//
// Design note: like `ClaudeReviewerBAdapter`, this is a thin
// compose-over-inherit wrapper. It extends `ClaudeAdapter` to share the
// full spawn / JSON-parse / timeout / error-classification plumbing. The
// only functional override is `critique()`, which prepends the persona
// prefix to the caller's guidelines and delegates to `super.critique()`.
// `ask()` and `revise()` delegate to the inherited implementations
// unchanged so the full Adapter contract stays live.
//
// Shared resolver (SPEC §11 coupled fallback): when constructed with a
// shared `ClaudeResolver` (as `buildReviewLoopAdaptersFromConfig` does
// for a Claude-vendor Reviewer A), this seat advances in lockstep with
// the lead + Reviewer B exactly like Reviewer B does.

import {
  ClaudeAdapter,
  buildCritiquePrompt,
  type ClaudeAdapterOpts,
} from "./claude.ts";
import { CODEX_CRITIQUE_PERSONA_PREFIX } from "./codex.ts";
import { type CritiqueInput, type CritiqueOutput } from "./types.ts";

// SPEC §7: literal security/ops persona prefix applied to Reviewer A
// critique() calls. Re-exported from the canonical Codex definition so
// the Claude-vendor seat is byte-for-byte identical to the Codex seat —
// the persona must not drift between vendors.
export const REVIEWER_A_PERSONA_PREFIX = CODEX_CRITIQUE_PERSONA_PREFIX;

/**
 * Build the full critique prompt for a Claude-vendor Reviewer A:
 * persona prefix + the caller's guidelines + the standard critique
 * prompt structure (schema + spec text). Exported so tests can inspect
 * the assembled prompt without spawning.
 */
export function buildCritiquePromptForReviewerA(input: CritiqueInput): string {
  const composedGuidelines = [REVIEWER_A_PERSONA_PREFIX, input.guidelines]
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
  return buildCritiquePrompt({ ...input, guidelines: composedGuidelines });
}

// ---------- ClaudeReviewerAAdapter ----------

export class ClaudeReviewerAAdapter extends ClaudeAdapter {
  // Vendor stays "claude": this seat uses the Claude CLI identically to
  // the lead. Contract tests and the `doctor` layer key on vendor.

  constructor(opts: ClaudeAdapterOpts = {}) {
    super(opts);
  }

  override critique(input: CritiqueInput): Promise<CritiqueOutput> {
    // Prepend the security/ops persona prefix to the guidelines, then
    // delegate to super.critique() so the inherited spawn + JSON-parse +
    // retry plumbing runs unchanged.
    const composedGuidelines = [REVIEWER_A_PERSONA_PREFIX, input.guidelines]
      .filter((s) => s.trim().length > 0)
      .join("\n\n");

    const withPersona: CritiqueInput = {
      ...input,
      guidelines: composedGuidelines,
    };
    return super.critique(withPersona);
  }
}
