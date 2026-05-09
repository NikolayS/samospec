// Copyright 2026 Nikolay Samokhvalov.

/**
 * Heuristic HTML brief renderer.
 *
 * A `BRIEF.html` is a *summarized derivative* of a published SPEC.md
 * — not a 1:1 HTML conversion. It's a single self-contained file
 * meant for stakeholder review and Pages-style publishing: stronger
 * visual hierarchy than markdown, much shorter than the spec,
 * deterministic so re-running gives byte-identical output.
 *
 * The renderer is pure and offline:
 *   - No model call. Pure string transformation. (Same discipline as
 *     `src/render/tldr.ts`.)
 *   - Same inputs → byte-identical output. The only non-deterministic
 *     input is `now`; callers pass it explicitly so tests pin it.
 *   - Output is a single HTML file with embedded CSS, no external
 *     fonts or scripts. Portable, signable, archivable.
 *
 * What it summarizes:
 *   - Title (from `# <title>` line).
 *   - Goal paragraph (from `## Goal` heading, falling back to the
 *     first paragraph after the title — same heuristic as TLDR.md).
 *   - Section index (every `## ` heading with first-sentence summary).
 *   - Round timeline (parsed from changelog.md `## vX.Y — date`
 *     entries with their bullets).
 *   - Metadata snapshot (rounds, exit reason, persona, adapter
 *     models from state.json).
 *
 * What it intentionally does NOT do:
 *   - Reproduce the full spec body. Brief, not export.
 *   - Invent content. Every output character traces to an input.
 *   - Make any model call. The "BRIEF" framing is the contract: you
 *     get a structured summary, not a re-imagining.
 */

import type { State } from "../state/types.ts";

export interface BriefInput {
  readonly slug: string;
  /** Full SPEC.md body (post-publish, read from `<blueprints_dir>/<slug>/`). */
  readonly spec: string;
  /** TLDR.md body (used as a goal-paragraph fallback). */
  readonly tldr: string;
  /** changelog.md body. */
  readonly changelog: string;
  /** Parsed state.json. */
  readonly state: State;
  /** ISO 8601 UTC timestamp for "generated at". Pinned by tests. */
  readonly now: string;
}

/** Render a BRIEF.html body string. Pure function. */
export function renderBrief(input: BriefInput): string {
  const title = extractTitle(input.spec) ?? input.slug;
  const goal = extractGoal(input.spec) ?? extractTldrGoal(input.tldr);
  const sections = extractSections(input.spec);
  const timeline = parseChangelog(input.changelog);
  const meta = collectMeta(input.state);

  const head = renderHead(title, input.state.published_version ?? "");
  const body = renderBody({
    slug: input.slug,
    title,
    goal,
    sections,
    timeline,
    meta,
    publishedAt: input.state.published_at ?? "—",
    publishedVersion: input.state.published_version ?? "—",
    now: input.now,
  });

  return [
    `<!doctype html>`,
    `<html lang="en">`,
    head,
    body,
    `</html>`,
    ``,
  ].join("\n");
}

// ---------- extractors ----------

/** First `# <title>` line, trimmed. Returns null if none. */
function extractTitle(spec: string): string | null {
  for (const raw of spec.split("\n")) {
    const m = /^#\s+(.+?)\s*$/.exec(raw);
    if (m?.[1] !== undefined) return m[1].trim();
  }
  return null;
}

/**
 * Mirror of `src/render/tldr.ts` extractGoal: first paragraph under
 * `## Goal`, then first paragraph after `# <title>`. Returns null when
 * neither yields content (caller falls back to the TLDR.md body).
 */
function extractGoal(spec: string): string | null {
  const lines = spec.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== undefined && /^##\s+Goal\s*$/i.test(lines[i] ?? "")) {
      const para = takeParagraph(lines, i + 1);
      if (para !== null) return para;
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== undefined && /^#\s+\S/.test(lines[i] ?? "")) {
      const para = takeParagraph(lines, i + 1);
      if (para !== null) return para;
      break;
    }
  }
  return null;
}

/**
 * Last-resort goal source: pull the paragraph under `## Goal` from
 * the already-rendered TLDR.md. TLDR.md is heuristically extracted
 * from the same spec so this stays consistent with TLDR.md / status.
 */
function extractTldrGoal(tldr: string): string {
  const goal = extractGoal(tldr);
  if (goal !== null) return goal;
  return "See SPEC.md for the goal statement.";
}

function takeParagraph(lines: readonly string[], start: number): string | null {
  let i = start;
  while (i < lines.length && (lines[i] ?? "").trim().length === 0) i += 1;
  const collected: string[] = [];
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) break;
    if (/^#{1,6}\s/.test(line)) break;
    collected.push(line.trim());
    i += 1;
  }
  if (collected.length === 0) return null;
  return collected.join(" ");
}

interface SectionEntry {
  readonly heading: string;
  readonly summary: string;
}

/**
 * Every top-level `## ` heading text (excluding `## Goal` — already
 * rendered above), paired with a one-sentence summary lifted from
 * the first paragraph beneath it. Empty summary when none available.
 */
function extractSections(spec: string): readonly SectionEntry[] {
  const lines = spec.split("\n");
  const out: SectionEntry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m === null) continue;
    const heading = (m[1] ?? "").trim();
    if (heading === "" || /^goal$/i.test(heading)) continue;
    const para = takeParagraph(lines, i + 1) ?? "";
    out.push({ heading, summary: firstSentence(para) });
  }
  return out;
}

/**
 * First sentence in a paragraph: split on `.`/`!`/`?` followed by
 * whitespace, take the first chunk. Caps at 240 chars to keep cards
 * scannable. Empty input returns empty string.
 */
function firstSentence(para: string): string {
  const trimmed = para.trim();
  if (trimmed === "") return "";
  const m = /^([\s\S]+?[.!?])(?:\s|$)/.exec(trimmed);
  const sentence = m?.[1] ?? trimmed;
  if (sentence.length <= 240) return sentence;
  return `${sentence.slice(0, 237)}…`;
}

interface TimelineEntry {
  readonly version: string;
  readonly date: string;
  readonly bullets: readonly string[];
}

/**
 * Parse changelog.md. Recognizes the `## vX.Y — date` heading shape
 * emitted by `samospec new` and round commits. Bullets are any lines
 * starting with `- ` until the next heading or EOF. Heading without
 * bullets still produces an entry (with `bullets: []`).
 */
function parseChangelog(changelog: string): readonly TimelineEntry[] {
  const lines = changelog.split("\n");
  const out: TimelineEntry[] = [];
  let cur: { version: string; date: string; bullets: string[] } | null = null;

  const HEADING = /^##\s+(v\d+(?:\.\d+){1,2})\s+[—–-]\s+(.+?)\s*$/;
  const BULLET = /^-\s+(.+?)\s*$/;

  for (const raw of lines) {
    const h = HEADING.exec(raw);
    if (h !== null) {
      if (cur !== null) out.push(cur);
      cur = { version: h[1] ?? "", date: h[2] ?? "", bullets: [] };
      continue;
    }
    if (cur !== null) {
      const b = BULLET.exec(raw);
      if (b?.[1] !== undefined) cur.bullets.push(b[1]);
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

interface MetaSnapshot {
  readonly rounds: number;
  readonly exitReason: string;
  readonly persona: string;
  readonly lead: string;
  readonly reviewerA: string;
  readonly reviewerB: string;
  readonly coupledFallback: boolean;
}

function collectMeta(state: State): MetaSnapshot {
  const adapters = state.adapters ?? {};
  return {
    rounds: state.round_index,
    exitReason: state.exit?.reason ?? "—",
    persona: state.persona?.skill ?? "—",
    lead: formatAdapter(adapters.lead),
    reviewerA: formatAdapter(adapters.reviewer_a),
    reviewerB: formatAdapter(adapters.reviewer_b),
    coupledFallback: state.coupled_fallback,
  };
}

function formatAdapter(
  res:
    | {
        readonly adapter: string;
        readonly model_id: string;
        readonly effort_used: string;
      }
    | undefined,
): string {
  if (res === undefined) return "—";
  return `${res.adapter} · ${res.model_id} · ${res.effort_used}`;
}

// ---------- HTML assembly ----------

function renderHead(title: string, version: string): string {
  const titleAttr =
    version === "" ? `Brief — ${title}` : `Brief — ${title} (${version})`;
  return [
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(titleAttr)}</title>`,
    `<style>${BRIEF_CSS}</style>`,
    `</head>`,
  ].join("\n");
}

interface RenderBodyArgs {
  readonly slug: string;
  readonly title: string;
  readonly goal: string;
  readonly sections: readonly SectionEntry[];
  readonly timeline: readonly TimelineEntry[];
  readonly meta: MetaSnapshot;
  readonly publishedAt: string;
  readonly publishedVersion: string;
  readonly now: string;
}

function renderBody(args: RenderBodyArgs): string {
  const fallbackBanner = args.meta.coupledFallback
    ? `<p class="brief-fallback" role="note">⚠️ Coupled fallback recorded — one or more adapters ran below policy. See SPEC §11.</p>`
    : "";
  return [
    `<body>`,
    `<main class="brief">`,
    renderHeader(args),
    fallbackBanner,
    renderMetaGrid(args.meta),
    renderGoal(args.goal),
    renderSectionIndex(args.sections),
    renderTimeline(args.timeline),
    renderFooter(args.slug, args.now),
    `</main>`,
    `</body>`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function renderHeader(args: RenderBodyArgs): string {
  return [
    `<header class="brief-header">`,
    `<p class="brief-kicker">Brief — derivative summary</p>`,
    `<h1 class="brief-title">${escapeHtml(args.title)}</h1>`,
    `<p class="brief-subtitle">`,
    `Slug <code>${escapeHtml(args.slug)}</code> ·`,
    ` Version ${escapeHtml(args.publishedVersion)} ·`,
    ` Published <time>${escapeHtml(args.publishedAt)}</time>`,
    `</p>`,
    `<p class="brief-warning">`,
    `This is a summarized derivative of the spec, not the spec itself.`,
    ` See <a href="./SPEC.md">SPEC.md</a> for the canonical document.`,
    `</p>`,
    `</header>`,
  ].join("\n");
}

function renderMetaGrid(meta: MetaSnapshot): string {
  const items: readonly (readonly [string, string])[] = [
    ["Rounds", String(meta.rounds)],
    ["Exit reason", meta.exitReason],
    ["Persona", meta.persona],
    ["Lead", meta.lead],
    ["Reviewer A", meta.reviewerA],
    ["Reviewer B", meta.reviewerB],
  ];
  const cards = items
    .map(
      ([k, v]) =>
        `<div class="brief-meta-card"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`,
    )
    .join("\n");
  return [
    `<section class="brief-meta" aria-labelledby="brief-meta-h">`,
    `<h2 id="brief-meta-h" class="brief-section-title">At a glance</h2>`,
    `<dl class="brief-meta-grid">`,
    cards,
    `</dl>`,
    `</section>`,
  ].join("\n");
}

function renderGoal(goal: string): string {
  return [
    `<section class="brief-goal">`,
    `<h2 class="brief-section-title">Goal</h2>`,
    `<p>${escapeHtml(goal)}</p>`,
    `</section>`,
  ].join("\n");
}

function renderSectionIndex(sections: readonly SectionEntry[]): string {
  if (sections.length === 0) {
    return [
      `<section class="brief-toc">`,
      `<h2 class="brief-section-title">What's in the spec</h2>`,
      `<p class="brief-empty">No top-level sections found beyond Goal.</p>`,
      `</section>`,
    ].join("\n");
  }
  const items = sections
    .map(
      (s) =>
        `<li><h3>${escapeHtml(s.heading)}</h3>${s.summary === "" ? "" : `<p>${escapeHtml(s.summary)}</p>`}</li>`,
    )
    .join("\n");
  return [
    `<section class="brief-toc" aria-labelledby="brief-toc-h">`,
    `<h2 id="brief-toc-h" class="brief-section-title">What's in the spec</h2>`,
    `<ol class="brief-section-list">`,
    items,
    `</ol>`,
    `</section>`,
  ].join("\n");
}

function renderTimeline(timeline: readonly TimelineEntry[]): string {
  if (timeline.length === 0) {
    return [
      `<section class="brief-timeline">`,
      `<h2 class="brief-section-title">Round timeline</h2>`,
      `<p class="brief-empty">No round entries in changelog.md.</p>`,
      `</section>`,
    ].join("\n");
  }
  const items = timeline
    .map((t) => {
      const bullets =
        t.bullets.length === 0
          ? ""
          : `<ul>${t.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`;
      return [
        `<li>`,
        `<header><strong>${escapeHtml(t.version)}</strong> · <time>${escapeHtml(t.date)}</time></header>`,
        bullets,
        `</li>`,
      ]
        .filter((s) => s !== "")
        .join("\n");
    })
    .join("\n");
  return [
    `<section class="brief-timeline" aria-labelledby="brief-timeline-h">`,
    `<h2 id="brief-timeline-h" class="brief-section-title">Round timeline</h2>`,
    `<ol class="brief-timeline-list">`,
    items,
    `</ol>`,
    `</section>`,
  ].join("\n");
}

function renderFooter(slug: string, now: string): string {
  return [
    `<footer class="brief-footer">`,
    `<p>Generated by <code>samospec brief ${escapeHtml(slug)}</code> on <time>${escapeHtml(now)}</time>. Re-run after each publish to refresh.</p>`,
    `<p>Canonical document: <a href="./SPEC.md">SPEC.md</a>.</p>`,
    `</footer>`,
  ].join("\n");
}

// ---------- security ----------

/**
 * Escape user-derived strings before interpolating into HTML. The
 * spec body is read from `blueprints/<slug>/SPEC.md` which is git-
 * versioned and reviewed, but reviewed-then-malicious is still a
 * thing — escape unconditionally.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- styles ----------

// Embedded CSS keeps BRIEF.html portable: opening it from a file://
// URL on a colleague's laptop must produce the same render as a
// Pages deploy. No external fonts (offline reading), no JS (single
// static artifact), system font stack so it adopts host typography.
const BRIEF_CSS = `
:root {
  --bg: #fdfdfc;
  --fg: #1a1a1a;
  --muted: #5a5a5a;
  --accent: #2547a3;
  --card-bg: #f4f3ef;
  --rule: #d8d6d1;
  --warn-bg: #fff4d4;
  --warn-fg: #4a3500;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
.brief {
  max-width: 760px;
  margin: 0 auto;
  padding: 2.5rem 1.25rem 4rem;
}
.brief-kicker {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.78rem;
  color: var(--muted);
  margin: 0 0 0.4rem;
}
.brief-title {
  font-size: 2.1rem;
  line-height: 1.15;
  margin: 0 0 0.6rem;
}
.brief-subtitle {
  color: var(--muted);
  margin: 0 0 1.2rem;
}
.brief-subtitle code {
  background: var(--card-bg);
  padding: 0.05em 0.35em;
  border-radius: 3px;
}
.brief-warning {
  background: var(--card-bg);
  border-left: 3px solid var(--accent);
  padding: 0.7rem 0.95rem;
  margin: 0 0 1.5rem;
  font-size: 0.92rem;
}
.brief-fallback {
  background: var(--warn-bg);
  color: var(--warn-fg);
  border: 1px solid #e3c878;
  border-radius: 4px;
  padding: 0.7rem 0.95rem;
  margin: 0 0 1.5rem;
  font-size: 0.92rem;
}
.brief-section-title {
  font-size: 1.2rem;
  border-bottom: 1px solid var(--rule);
  padding-bottom: 0.3rem;
  margin: 2.2rem 0 1rem;
}
.brief-meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 0.6rem;
  margin: 0;
}
.brief-meta-card {
  background: var(--card-bg);
  padding: 0.55rem 0.75rem;
  border-radius: 4px;
}
.brief-meta-card dt {
  font-size: 0.74rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin: 0 0 0.15rem;
}
.brief-meta-card dd {
  margin: 0;
  font-size: 0.95rem;
  word-break: break-word;
}
.brief-section-list {
  list-style: decimal inside;
  padding: 0;
  margin: 0;
}
.brief-section-list li {
  margin: 0 0 1rem;
  padding-left: 0.4rem;
}
.brief-section-list h3 {
  display: inline;
  font-size: 1rem;
  margin: 0;
}
.brief-section-list p {
  margin: 0.3rem 0 0 1.4rem;
  color: var(--muted);
  font-size: 0.95rem;
}
.brief-timeline-list {
  list-style: none;
  padding: 0;
  margin: 0;
  border-left: 2px solid var(--rule);
}
.brief-timeline-list > li {
  padding: 0.4rem 0 1rem 1rem;
  margin-left: -2px;
  border-left: 2px solid transparent;
}
.brief-timeline-list > li:hover {
  border-left-color: var(--accent);
}
.brief-timeline-list header {
  font-size: 0.95rem;
  margin-bottom: 0.25rem;
}
.brief-timeline-list time {
  color: var(--muted);
  font-size: 0.88rem;
}
.brief-timeline-list ul {
  margin: 0.3rem 0 0;
  padding-left: 1.2rem;
}
.brief-empty {
  color: var(--muted);
  font-style: italic;
}
.brief-footer {
  margin-top: 3rem;
  padding-top: 1rem;
  border-top: 1px solid var(--rule);
  color: var(--muted);
  font-size: 0.88rem;
}
.brief-footer p { margin: 0 0 0.4rem; }
a { color: var(--accent); }
code {
  font: inherit;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.92em;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15171c;
    --fg: #e6e6e6;
    --muted: #9a9a9a;
    --accent: #8ab4ff;
    --card-bg: #21242b;
    --rule: #2c2f37;
    --warn-bg: #3a3215;
    --warn-fg: #ffe49a;
  }
}
@media print {
  .brief { max-width: none; padding: 0; }
  .brief-warning, .brief-fallback { break-inside: avoid; }
}
`.trim();
