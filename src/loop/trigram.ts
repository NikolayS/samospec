// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §12 condition 4 — repeat-findings halt algorithm.
 *
 * Normalization: lowercase + strip ASCII punctuation + collapse whitespace
 * to single spaces + trim. Applied to each finding's text before similarity
 * comparison, per SPEC §13 test 8 (`"the spec"` ≡ `"The spec."`).
 *
 * Trigram Jaccard similarity: `|A ∩ B| / |A ∪ B|` over the set of 3-char
 * substrings (overlapping windows) of the normalized texts. Empty on
 * either side yields 0 (avoid division by zero).
 *
 * Trigrams are calculated on normalized text. We treat input as a stream
 * of UTF-16 code units (the same way JavaScript iterates by default);
 * this is coarser than grapheme-clusters but matches v0.6 wording ("3-char
 * substrings"). Tests cover ASCII; non-ASCII input isn't prohibited but
 * is not normalized beyond the lowercase step.
 */

/** Strip ASCII punctuation per SPEC §12 condition 4 normalization. */
const ASCII_PUNCT_RE = /[!-/:-@[-`{-~]/g;

/** Collapse any whitespace (incl. tabs, newlines) to single spaces. */
const WHITESPACE_RE = /\s+/g;

export function normalizeForRepeatDetection(text: string): string {
  return text
    .toLowerCase()
    .replace(ASCII_PUNCT_RE, " ")
    .replace(WHITESPACE_RE, " ")
    .trim();
}

export function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  if (text.length < 3) return out;
  for (let i = 0; i <= text.length - 3; i += 1) {
    out.add(text.slice(i, i + 3));
  }
  return out;
}

/**
 * Trigram Jaccard similarity on the two raw texts. Callers that want
 * normalized similarity should pass normalized strings — this helper
 * deliberately does NOT normalize so it can be tested in isolation and
 * reused by tooling that has already normalized.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) {
    if (B.has(t)) inter += 1;
  }
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Convenience: normalize both texts first, then compute Jaccard.
 * Used by stopping-condition tests that want the one-shot SPEC §12
 * algorithm behavior.
 */
export function normalizedJaccard(a: string, b: string): number {
  return jaccardSimilarity(
    normalizeForRepeatDetection(a),
    normalizeForRepeatDetection(b),
  );
}
