// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §5 Phase 7 — PR body composition.
 *
 * The PR body contains, in order:
 *   1. Heading: `spec(<slug>): publish <version>`.
 *   2. Spec summary: the TLDR.md body (as the reviewer's first read).
 *   3. Meta: rounds run, exit reason, degraded resolution if any.
 *   4. Changelog since v0.1 (verbatim from changelog.md).
 *   5. Publish-lint:
 *      - Hard warnings surfaced prominently (non-blocking per SPEC §14).
 *      - Soft warnings in a collapsible `<details>` section.
 *
 * Markdown uses `- ` list items per CLAUDE.md. Timestamps remain in
 * the changelog's ISO form.
 */

import type { PublishLintReport } from "./lint-stub.ts";

export interface BuildPrBodyOpts {
  readonly slug: string;
  /** `vX.Y` or `vX.Y.Z`. */
  readonly version: string;
  /** Raw TLDR.md body from `.samo/spec/<slug>/TLDR.md`. */
  readonly tldr: string;
  /** Raw changelog.md body. */
  readonly changelog: string;
  readonly roundCount: number;
  readonly exitReason: string;
  /** Summary string if any adapter is running under a degraded
   *  resolution; `null` otherwise. */
  readonly degradedResolution: string | null;
  readonly lintReport: PublishLintReport;
}

export function buildPrBody(opts: BuildPrBodyOpts): string {
  const out: string[] = [];
  out.push(`# spec(${opts.slug}): publish ${opts.version}`);
  out.push("");

  out.push("## Spec summary");
  out.push("");
  out.push(opts.tldr.trimEnd());
  out.push("");

  out.push("## Publish meta");
  out.push("");
  out.push(`- Rounds run: ${String(opts.roundCount)}`);
  out.push(`- Final exit reason: ${opts.exitReason}`);
  if (opts.degradedResolution !== null && opts.degradedResolution.length > 0) {
    out.push(`- Degraded resolution: ${opts.degradedResolution}`);
  }
  out.push("");

  out.push("## Changelog since v0.1");
  out.push("");
  out.push(opts.changelog.trimEnd());
  out.push("");

  out.push("## Publish lint");
  out.push("");
  const hard = opts.lintReport.hardWarnings;
  if (hard.length === 0) {
    out.push("- Hard warnings: none.");
  } else {
    out.push("### Hard warnings");
    out.push("");
    for (const f of hard) {
      out.push(`- \`${f.id}\` — ${f.message}`);
    }
  }
  out.push("");

  const soft = opts.lintReport.softWarnings;
  if (soft.length === 0) {
    out.push("- Soft warnings: none.");
  } else {
    out.push("<details>");
    out.push("<summary>Soft warnings</summary>");
    out.push("");
    for (const f of soft) {
      out.push(`- \`${f.id}\` — ${f.message}`);
    }
    out.push("");
    out.push("</details>");
  }
  out.push("");

  return out.join("\n");
}
