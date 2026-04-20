// Copyright 2026 Nikolay Samokhvalov.

import { PATTERNS } from "./patterns.ts";

/**
 * Replace secret-shaped substrings with `<redacted:kind>` placeholders.
 *
 * Scope (SPEC §9, §14):
 *   - Runs over transcript content before it is written to disk (Sprint 3
 *     wires this). This sprint ships the function + property tests +
 *     `doctor` entropy check.
 *   - Does NOT recurse into `context.json` file-path strings or
 *     `decisions.md` user prose. SPEC §18 lists that as an open question
 *     for post-v1; `docs/security.md` documents the gap explicitly.
 *   - Best-effort. Run an external scanner (gitleaks, truffleHog) for
 *     sensitive repos — see SPEC §14 + `samospec doctor`.
 *
 * Idempotent: `redact(redact(s)) === redact(s)` because `<redacted:kind>`
 * placeholders do not match any pattern in the corpus.
 */
export function redact(text: string): string {
  let out = text;
  for (const p of PATTERNS) {
    // Each regex carries the `g` flag so replace() hits every match on
    // the line. Recreating the replacement string fresh inside the
    // callback keeps the kind label tied to the matching rule.
    out = out.replace(p.regex, () => `<redacted:${p.kind}>`);
  }
  return out;
}
