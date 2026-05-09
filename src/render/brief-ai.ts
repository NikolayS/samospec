// Copyright 2026 Nikolay Samokhvalov.

/**
 * AI-generated rich HTML brief — `samospec brief --ai`.
 *
 * Background: the heuristic renderer (src/render/brief.ts) deliver
 * structured-markdown-as-HTML. To deliver the rich visual artifact
 * Thariq's "unreasonable effectiveness of HTML" post describes —
 * SVG architecture diagrams synthesized from architecture.json,
 * side-by-side scope tables, mobile-responsive layout, callouts —
 * we need a model in the loop. This module is that loop.
 *
 * Two-pass design:
 *   1. Lead adapter generates the HTML brief from SPEC.md +
 *      architecture.json + decisions.md + TLDR.md.
 *   2. Verifier adapter (cross-vendor by default) compares the
 *      generated brief against SPEC.md and flags any claims that
 *      can't be traced back. Inventions trigger a regenerate (up to
 *      2 retries with the verifier's findings appended to the
 *      generation prompt).
 *
 * Caching: by `sha256(GEN_PROMPT_VERSION || SPEC.md || architecture.json)`
 * — re-running for the same published spec returns the cached HTML
 * without re-spending model calls. Cache lives in `.samo/cache/brief/`
 * (gitignored).
 *
 * Safety: model output is sanitized — `<script>`, `<iframe>`,
 * `on*=` event handlers, `javascript:` URLs are stripped. The model
 * is prompted to inline all CSS and avoid remote resources, but we
 * scrub anyway; brief HTML is committed and served on Pages, where
 * a malicious model output could become a stored XSS vector.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Adapter, AskOutput } from "../adapter/types.ts";

const GEN_PROMPT_VERSION = "v1";
const MAX_RETRY = 2;

export interface AiBriefInput {
  readonly slug: string;
  readonly cwd: string;
  /** Canonical SPEC.md (post-publish). */
  readonly spec: string;
  /** architecture.json raw text — primary source for SVG diagrams. */
  readonly architecture: string;
  /** decisions.md raw text. */
  readonly decisions: string;
  /** TLDR.md raw text. */
  readonly tldr: string;
  readonly publishedVersion: string;
  readonly publishedAt: string;
  /** Lead adapter (typically claude-opus-4-7 at effort: max). */
  readonly lead: Adapter;
  /** Verifier adapter (typically codex for cross-vendor). null = skip. */
  readonly verifier: Adapter | null;
  readonly noCache: boolean;
  /** Per-call timeout in ms. Default 240_000 (4 min for rich HTML). */
  readonly timeoutMs: number;
}

export interface AiBriefResult {
  readonly html: string;
  readonly cached: boolean;
  /** Inventions surfaced by the final verifier pass (empty when ok). */
  readonly inventions: readonly Invention[];
  /** True if any verifier pass ran. */
  readonly verified: boolean;
  /** Number of generation attempts (1..=MAX_RETRY+1). */
  readonly attempts: number;
}

export interface Invention {
  readonly claim: string;
  readonly spec_says: string;
}

export async function generateAiBrief(
  input: AiBriefInput,
): Promise<AiBriefResult> {
  const cacheKey = computeCacheKey(input.spec, input.architecture);
  const cachePath = path.join(
    input.cwd,
    ".samo",
    "cache",
    "brief",
    `${input.slug}-${cacheKey}.html`,
  );

  if (!input.noCache && existsSync(cachePath)) {
    return {
      html: readFileSync(cachePath, "utf8"),
      cached: true,
      inventions: [],
      verified: false,
      attempts: 0,
    };
  }

  let html = "";
  let inventions: Invention[] = [];
  let retryHint: string | null = null;
  let attempts = 0;
  const verified = input.verifier !== null;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt += 1) {
    attempts += 1;
    const genOut = await callGenerate(input, retryHint);
    html = sanitizeHtml(extractHtml(genOut.answer));

    if (input.verifier === null) {
      inventions = [];
      break;
    }

    const verifyResult = await callVerify(input, html);
    inventions = [...verifyResult.inventions];
    if (verifyResult.ok) break;

    if (attempt < MAX_RETRY) {
      retryHint = formatRetryHint(verifyResult.inventions);
    }
  }

  mkdirSync(path.dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, html, "utf8");

  return { html, cached: false, inventions, verified, attempts };
}

// ---------- generation ----------

async function callGenerate(
  input: AiBriefInput,
  retryHint: string | null,
): Promise<AskOutput> {
  const context = [
    `## Spec metadata`,
    `- slug: ${input.slug}`,
    `- published_version: ${input.publishedVersion}`,
    `- published_at: ${input.publishedAt}`,
    ``,
    `## SPEC.md (canonical source)`,
    "```markdown",
    input.spec,
    "```",
    ``,
    `## architecture.json (primary source for SVG diagrams)`,
    "```json",
    input.architecture,
    "```",
    ``,
    `## decisions.md`,
    "```markdown",
    input.decisions,
    "```",
    ``,
    `## TLDR.md`,
    "```markdown",
    input.tldr,
    "```",
  ].join("\n");

  const prompt =
    retryHint === null ? GEN_PROMPT : `${GEN_PROMPT}\n\n${retryHint}`;

  return input.lead.ask({
    prompt,
    context,
    opts: { effort: "max", timeout: input.timeoutMs },
    slug: input.slug,
  });
}

async function callVerify(
  input: AiBriefInput,
  html: string,
): Promise<{ ok: boolean; inventions: Invention[] }> {
  if (input.verifier === null) return { ok: true, inventions: [] };

  const context = [
    `## Source SPEC.md (authoritative)`,
    "```markdown",
    input.spec,
    "```",
    ``,
    `## Generated BRIEF.html (under review)`,
    "```html",
    html,
    "```",
  ].join("\n");

  const out = await input.verifier.ask({
    prompt: VERIFY_PROMPT,
    context,
    opts: { effort: "max", timeout: input.timeoutMs },
    slug: input.slug,
  });

  return parseVerifierResponse(out.answer);
}

function parseVerifierResponse(answer: string): {
  ok: boolean;
  inventions: Invention[];
} {
  // The verifier MAY wrap JSON in a code fence; pull it out either way.
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(answer);
  const candidate = fence?.[1] ?? answer;
  const jsonMatch = /\{[\s\S]*\}/.exec(candidate);
  if (jsonMatch === null) {
    return {
      ok: false,
      inventions: [
        {
          claim: "verifier returned no JSON object",
          spec_says: answer.slice(0, 200),
        },
      ],
    };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {
        ok: false,
        inventions: [
          { claim: "verifier returned non-object JSON", spec_says: "" },
        ],
      };
    }
    const obj = parsed as { ok?: unknown; inventions?: unknown };
    const ok = obj.ok === true;
    const raw = Array.isArray(obj.inventions) ? obj.inventions : [];
    const inventions: Invention[] = raw
      .filter(
        (x): x is Record<string, unknown> =>
          typeof x === "object" && x !== null,
      )
      .map((x) => ({
        claim: typeof x["claim"] === "string" ? x["claim"] : "",
        spec_says: typeof x["spec_says"] === "string" ? x["spec_says"] : "",
      }));
    return { ok, inventions };
  } catch {
    return {
      ok: false,
      inventions: [
        {
          claim: "verifier JSON parse failed",
          spec_says: answer.slice(0, 200),
        },
      ],
    };
  }
}

function formatRetryHint(inventions: readonly Invention[]): string {
  const list = inventions
    .slice(0, 5)
    .map(
      (i, k) =>
        `  ${String(k + 1)}. claim: "${i.claim}" — spec_says: "${i.spec_says}"`,
    )
    .join("\n");
  return [
    `## Retry guidance`,
    `The previous brief contained content that the verifier could not trace`,
    `back to SPEC.md. Revise to remove these inventions; render only what`,
    `traces verbatim or as a faithful summary:`,
    list,
  ].join("\n");
}

// ---------- post-processing ----------

/** Pull the HTML body from the model's response, tolerating fencing. */
function extractHtml(answer: string): string {
  const fence = /```html\s*\n([\s\S]*?)\n```/.exec(answer);
  if (fence?.[1] !== undefined) return fence[1].trim();
  const trimmed = answer.trim();
  if (
    trimmed.toLowerCase().startsWith("<!doctype") ||
    trimmed.toLowerCase().startsWith("<html")
  ) {
    return trimmed;
  }
  // Last resort: wrap fragment in a minimal scaffold.
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"></head><body>',
    trimmed,
    "</body></html>",
  ].join("\n");
}

/**
 * Strip dangerous markup. Brief HTML is committed and served on
 * Pages; a malicious model could become stored XSS otherwise. The
 * generation prompt also forbids these, but we scrub independently
 * — defense in depth.
 */
export function sanitizeHtml(html: string): string {
  let s = html;
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<script\b[^>]*\/?>/gi, "");
  s = s.replace(/<(iframe|object|embed|link|base)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<(iframe|object|embed|link|base)\b[^>]*\/?>/gi, "");
  s = s.replace(/<meta\s+http-equiv\b[^>]*\/?>/gi, "");
  s = s.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "");
  s = s.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
  s = s.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "");
  s = s.replace(/(?<==["'])\s*javascript:/gi, "blocked:");
  return s;
}

function computeCacheKey(spec: string, architecture: string): string {
  return createHash("sha256")
    .update(GEN_PROMPT_VERSION)
    .update("\0")
    .update(spec)
    .update("\0")
    .update(architecture)
    .digest("hex")
    .slice(0, 16);
}

// ---------- prompts ----------

const GEN_PROMPT = `You produce BRIEF.html — a single self-contained HTML file that summarizes
a software specification for stakeholder review. A reader spends 5–10
minutes here instead of the full 30-page spec.

Use the full visual range of HTML to maximize information density and
clarity:
- SVG diagrams for architecture and data flow, synthesized from
  architecture.json (nodes, edges, groups). When architecture.json is
  empty, derive from prose.
- Tables for tabular data: in-scope vs out-of-scope side by side,
  decision matrices, comparisons.
- Visual hierarchy via CSS, not just headings: callout boxes for risks
  and open questions, color-coded section types, sticky table-of-contents
  on wide viewports.
- Mobile-responsive: CSS grid / flex with sensible breakpoints; viewport
  meta tag.
- Inline ALL CSS in a single <style> tag. System font stack only.
  Support \`prefers-color-scheme: dark\`.

Header (top of <body>):
- A small kicker line that reads: \`Brief — derivative summary\`
- H1 with the spec title (from the # line)
- A subtitle with slug, version, published date, and a link to ./SPEC.md
- A short disclaimer that this is a summary, not the spec, and to
  consult SPEC.md for the canonical text.

Sections to feature (in this priority order, when material exists):
1. **Goal** (full paragraph)
2. **Product thesis** if present
3. **Architecture** — with an SVG diagram. Synthesize from architecture.json.
4. **Scope** — in-scope and out-of-scope as a side-by-side table or
   two-column layout
5. **Decisions** — render as a decision log table (date / decision /
   rationale where derivable)
6. **Open questions** — bulleted callout
7. **Risks / failure modes** — bulleted callout with a warning tone
8. Other H2 sections in spec order

Footer (bottom of <body>):
- One compact provenance line: rounds, lead adapter, link to SPEC.md.
  Do NOT make process metadata prominent.

CONSTRAINTS — these are blocking:
- Render only content that traces to SPEC.md, architecture.json,
  decisions.md, or TLDR.md. Do NOT invent claims, numbers, features,
  commitments, dates, or names.
- No <script> tags. No <iframe>, <object>, <embed>. No on*= event
  handlers. No remote stylesheets, fonts, scripts, or images.
- Single self-contained HTML5 document. No prose preamble in your
  response — output the document directly (you may wrap it in
  \`\`\`html ... \`\`\`).
- Mobile-responsive. Print-friendly (use \`@media print\`).

Output: a single complete HTML5 document.`;

const VERIFY_PROMPT = `You verify a BRIEF.html against its source SPEC.md. Find any content
in the brief that does NOT appear in (or faithfully summarize) the
SPEC.md.

Look for:
- Specific numbers, names, percentages, dates, version strings
- Architectural claims not supported by the spec body
- Risks, decisions, open questions not present in SPEC
- Section headings invented by the brief
- Promises or commitments the spec does not make

Output strict JSON, nothing else. Either:
{ "ok": true, "inventions": [] }

or:
{
  "ok": false,
  "inventions": [
    { "claim": "the brief asserts X", "spec_says": "but SPEC says Y or nothing" },
    ...
  ]
}

List up to 10 inventions. Do not include nits, formatting choices, or
faithful paraphrases. Only flag content that materially diverges from
the spec.`;
