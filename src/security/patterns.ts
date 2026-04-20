// Copyright 2026 Nikolay Samokhvalov.

/**
 * Redaction regex corpus (SPEC §9). Patterns intentionally narrow — the
 * goal is high precision on real credentials with no false positives on
 * spec prose (`v1.2.3`, `foo.bar.baz`, `example.com.au`, paths).
 *
 * Sourced from the gitleaks + truffleHog rule sets. Kept deliberately
 * small: `samospec` does not aim to replace those scanners; SPEC §14
 * explicitly recommends running them on sensitive repos. This corpus is
 * the "best-effort" pass applied before writing transcripts and the
 * signal that drives the `doctor` entropy warning.
 *
 * DO NOT embed real credentials in doc comments. If a pattern's shape
 * needs illustrating, use `EXAMPLE` / `example` as filler.
 */

export interface RedactionPattern {
  /** Machine-readable kind emitted in the `<redacted:kind>` placeholder. */
  readonly kind: string;
  /** Human-readable label for log output. */
  readonly label: string;
  /**
   * Regex that matches the secret shape. MUST be a global regex (`g`)
   * so `String.prototype.replace` redacts every occurrence, not just
   * the first.
   */
  readonly regex: RegExp;
}

// Placeholder — actual patterns ship in the GREEN commit.
export const PATTERNS: readonly RedactionPattern[] = [];
