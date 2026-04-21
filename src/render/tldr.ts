// Copyright 2026 Nikolay Samokhvalov.

// SPEC §5 Phase 5 + §9 — heuristic `TLDR.md` renderer.
//
// Scope guard (per Issue #15):
//   - No extra model call. Pure string transformation of the drafted
//     SPEC.md.
//   - Heuristic only. The rendered TL;DR is auditable — the user can
//     see how it was derived from the spec text without an LLM round-
//     trip. Formal summary generation is out of scope for v1.
//
// Extraction rules:
//   - goal: first paragraph after a `## Goal` heading, if present.
//     Otherwise, first non-empty paragraph after the `# <title>` line.
//     Otherwise, a placeholder pointing the reader at SPEC.md.
//   - scope: bullet list of every top-level `## ` heading in the spec,
//     excluding `## Goal` (which is rendered above).
//   - next-action: derived from state via `computeNextAction` (Issue #96)
//     so TLDR.md, `samospec status`, and the `iterate` stdout tail
//     always agree on the recommendation. When `state` is omitted the
//     renderer falls back to the old pre-state resume hint so pure-spec
//     unit tests still work.

import { computeNextAction } from "../state/next-action.ts";
import type { State } from "../state/types.ts";

export interface RenderTldrOpts {
  readonly slug: string;
  /**
   * When provided, the Next-action section is derived from state via
   * `computeNextAction`. Callers (iterate / new / resume) that have a
   * State in hand SHOULD pass it so TLDR.md stays consistent with
   * status and iterate's stdout.
   */
  readonly state?: State;
}

/**
 * Render a TL;DR.md body from a drafted SPEC.md string. Never hits the
 * network; never calls an adapter. Deterministic on a given input.
 */
export function renderTldr(spec: string, opts: RenderTldrOpts): string {
  const goal = extractGoal(spec);
  const sections = extractScopeSections(spec);

  const lines: string[] = [];
  lines.push("# TL;DR");
  lines.push("");

  lines.push("## Goal");
  lines.push("");
  lines.push(goal);
  lines.push("");

  if (sections.length > 0) {
    lines.push("## Scope summary");
    lines.push("");
    for (const s of sections) {
      lines.push(`- ${s}`);
    }
    lines.push("");
  }

  lines.push("## Next action");
  lines.push("");
  lines.push(nextActionLine(opts));
  lines.push("");

  return lines.join("\n");
}

/**
 * Render the Next-action section body. When `state` is provided, route
 * through the shared `computeNextAction` helper so the TLDR.md file
 * never disagrees with `samospec status` or `iterate` stdout (#96).
 * Without state, fall back to the pre-#96 resume hint.
 */
function nextActionLine(opts: RenderTldrOpts): string {
  if (opts.state !== undefined) {
    return `\`${computeNextAction(opts.state, opts.slug)}\``;
  }
  return `resume with \`samospec resume ${opts.slug}\``;
}

/**
 * Find the first paragraph under a `## Goal` heading. A paragraph is a
 * run of consecutive non-blank lines; blank lines terminate it. Falls
 * back to the first paragraph after the `# <title>` line, then to a
 * placeholder pointer.
 */
function extractGoal(spec: string): string {
  const lines = spec.split("\n");

  // Pass 1: look for `## Goal`.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (/^##\s+Goal\s*$/i.test(line)) {
      const para = takeParagraphAt(lines, i + 1);
      if (para !== null) return para;
    }
  }

  // Pass 2: first paragraph after the `# <title>` line.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (/^#\s+\S/.test(line)) {
      const para = takeParagraphAt(lines, i + 1);
      if (para !== null) return para;
      break;
    }
  }

  return "See SPEC.md for the full goal statement.";
}

/**
 * Walk from `start` forward, skipping blank lines, then collect
 * consecutive non-blank non-heading lines into a single space-joined
 * paragraph. Returns null if nothing found.
 */
function takeParagraphAt(
  lines: readonly string[],
  start: number,
): string | null {
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line !== undefined && line.trim().length !== 0) {
      break;
    }
    i += 1;
  }
  const collected: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim().length === 0) break;
    // A heading line inside a paragraph is uncommon but we stop early so
    // the first-paragraph fallback does not absorb a subsequent section.
    if (/^#{1,6}\s/.test(line)) break;
    collected.push(line.trim());
    i += 1;
  }
  if (collected.length === 0) return null;
  return collected.join(" ");
}

/**
 * Return every top-level `## ` heading text, excluding `## Goal`. Order
 * preserved. Duplicates allowed (the spec's headings are the record).
 */
function extractScopeSections(spec: string): readonly string[] {
  const out: string[] = [];
  for (const raw of spec.split("\n")) {
    const m = /^##\s+(.+?)\s*$/.exec(raw);
    if (m === null) continue;
    const title = (m[1] ?? "").trim();
    if (title === "") continue;
    if (/^goal$/i.test(title)) continue;
    out.push(title);
  }
  return out;
}
