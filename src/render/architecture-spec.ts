// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §3 + Issue #107 — SPEC.md integration for the architecture
 * diagram. Given a SPEC.md string and an Architecture, emit a new
 * SPEC.md with a sentinel-delimited ASCII block either replaced
 * (when sentinels exist) or injected (when they don't).
 *
 * Design note: we chose post-processing over augmenting the lead
 * adapter's prompt. Reasons:
 *   - Determinism: the block is a pure function of architecture.json,
 *     independent of however the lead phrased SPEC.md this round.
 *   - Round-trip safety: iterate may regenerate SPEC.md text every
 *     round; the block is always re-rendered from JSON so it can't
 *     drift from the schema.
 *   - Backward compatibility: specs without sentinels get them added
 *     additively. No existing file gets its prose rearranged.
 *
 * Sentinel grammar: literal HTML comments so they survive Markdown
 * rendering on GitHub / local viewers and are trivial to regex.
 */

import type { Architecture } from "../state/architecture.ts";
import { renderArchitectureAscii } from "./architecture-ascii.ts";

export const ARCHITECTURE_BEGIN_SENTINEL = "<!-- architecture:begin -->";
export const ARCHITECTURE_END_SENTINEL = "<!-- architecture:end -->";

// Matches an optional one-line Markdown heading containing the word
// "Architecture" (case-insensitive). Used to find an insertion point
// when sentinels are absent. Whitespace-lenient on purpose — specs in
// the wild use `## Architecture`, `## 3. Architecture`, `### System
// architecture`, etc.
const ARCHITECTURE_HEADING_RE = /^(#{2,6})\s+.*architecture\b.*$/im;
const TECHNICAL_NOTES_HEADING_RE = /^##[ \t]+Technical notes[ \t]*$/im;

/**
 * Replace or inject the architecture block in `spec`. Returns a new
 * string; never mutates. Pure function of its inputs.
 */
export function injectArchitectureBlock(
  spec: string,
  doc: Architecture,
  options: { readonly skipSections?: readonly string[] } = {},
): string {
  const block = renderBlock(doc);

  // Case 1: sentinels already exist — swap the body.
  const begin = spec.indexOf(ARCHITECTURE_BEGIN_SENTINEL);
  const end = spec.indexOf(ARCHITECTURE_END_SENTINEL);
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = spec.slice(0, begin);
    const after = spec.slice(end + ARCHITECTURE_END_SENTINEL.length);
    return `${before}${block}${after}`;
  }

  // Case 2: an Architecture heading exists — insert the block right
  // after the heading's blank line so existing prose stays below it.
  const headingMatch = ARCHITECTURE_HEADING_RE.exec(spec);
  if (headingMatch !== null) {
    const headingEnd = (headingMatch.index ?? 0) + headingMatch[0].length;
    const before = spec.slice(0, headingEnd);
    const after = spec.slice(headingEnd);
    const joiner = spec.startsWith("\n", headingEnd) ? "\n\n" : "\n\n";
    return `${before}${joiner}${block}${after.startsWith("\n") ? "" : "\n"}${after}`;
  }

  if (
    (options.skipSections ?? []).some(
      (section) => section.trim().toLowerCase() === "architecture",
    )
  ) {
    return spec;
  }

  // Case 3: add Architecture as a subsection of Technical notes.
  const technicalNotes = TECHNICAL_NOTES_HEADING_RE.exec(spec);
  if (technicalNotes !== null) {
    const headingEnd = technicalNotes.index + technicalNotes[0].length;
    const after = spec.slice(headingEnd).replace(/^\n+/, "");
    return `${spec.slice(0, headingEnd)}\n\n### Architecture\n\n${block}\n\n${after}`;
  }

  // Case 4: create Technical notes before the final changelog when present.
  const changelog = /^##\s+(?:Embedded )?Changelog\b.*$/im.exec(spec);
  const insertion = changelog?.index ?? spec.length;
  const before = spec.slice(0, insertion).replace(/\n*$/, "\n\n");
  const after = spec.slice(insertion);
  return `${before}## Technical notes\n\n### Architecture\n\n${block}\n\n${after}`;
}

/**
 * Produce the sentinel-delimited block body (including both sentinels
 * and a fenced `text` code block for the diagram). The fence tags the
 * content as `text` so Markdown renderers do not try to interpret the
 * box-drawing characters; viewers still show the ASCII as intended.
 */
function renderBlock(doc: Architecture): string {
  const ascii = renderArchitectureAscii(doc);
  const lines: string[] = [
    ARCHITECTURE_BEGIN_SENTINEL,
    "",
    "```text",
    ascii,
    "```",
    "",
    ARCHITECTURE_END_SENTINEL,
  ];
  return lines.join("\n");
}
