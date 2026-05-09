// Copyright 2026 Nikolay Samokhvalov.

/**
 * Heuristic HTML brief renderer — content-forward.
 *
 * A `BRIEF.html` is a *summarized derivative* of a published SPEC.md.
 * Goal: a stakeholder spends 5–10 minutes here instead of reading
 * the full 30-page spec, and walks away with the substance — overall
 * shape, architecture, scope boundaries, decisions, open questions,
 * risks. Process metadata (review rounds, adapter models, persona)
 * is one tiny footer line; it's NOT the headline.
 *
 * The renderer is pure and offline:
 *   - No model call. Pure string transformation. Same inputs →
 *     byte-identical output (only `now` varies, and callers pin it).
 *   - Output is a single HTML file with embedded CSS, no external
 *     fonts or scripts.
 *
 * Per-section extraction:
 *   - Walk H2 sections in spec order.
 *   - For each: collect up to 3 leading paragraphs, the first bullet
 *     list (up to 7 items, with `(N more)` indicator if truncated),
 *     fenced code blocks (preserved verbatim — diagrams, schemas,
 *     SQL must not be lost), `###` subsection names.
 *   - Classify by heading name so layout adapts (scope-out cards
 *     read differently from generic prose; risks get a warning tone).
 *
 * Inline markdown:
 *   - `**bold**`, `*italic*`, `` `code` `` are converted to
 *     `<strong>`, `<em>`, `<code>` in body text. Pre-escape first so
 *     no raw HTML can sneak through.
 */

import type { State } from "../state/types.ts";

export interface BriefInput {
  readonly slug: string;
  /** Full SPEC.md body (post-publish, read from `<blueprints_dir>/<slug>/`). */
  readonly spec: string;
  /** TLDR.md body (used as a goal-paragraph fallback). */
  readonly tldr: string;
  /** changelog.md body (parsed for provenance footer). */
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
  const rounds = countRounds(input.changelog);

  const head = renderHead(title, input.state.published_version ?? "");
  const body = renderBody({
    slug: input.slug,
    title,
    goal,
    sections,
    publishedAt: input.state.published_at ?? "—",
    publishedVersion: input.state.published_version ?? "—",
    coupledFallback: input.state.coupled_fallback,
    rounds,
    leadLabel: formatAdapter(input.state.adapters?.lead),
    reviewerALabel: formatAdapter(input.state.adapters?.reviewer_a),
    reviewerBLabel: formatAdapter(input.state.adapters?.reviewer_b),
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
 * First paragraph under `## Goal`, then first paragraph after
 * `# <title>`. Null when neither yields content (caller falls back
 * to TLDR.md).
 */
function extractGoal(spec: string): string | null {
  const lines = spec.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+Goal\s*$/i.test(lines[i] ?? "")) {
      const para = takeParagraph(lines, i + 1);
      if (para !== null) return para;
    }
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (/^#\s+\S/.test(lines[i] ?? "")) {
      const para = takeParagraph(lines, i + 1);
      if (para !== null) return para;
      break;
    }
  }
  return null;
}

function extractTldrGoal(tldr: string): string {
  return extractGoal(tldr) ?? "See SPEC.md for the goal statement.";
}

/**
 * Single paragraph at `start`: strip leading list markers, join
 * consecutive non-blank, non-heading, non-fence lines. Returns null
 * when nothing was collected.
 */
function takeParagraph(lines: readonly string[], start: number): string | null {
  let i = start;
  while (i < lines.length && (lines[i] ?? "").trim().length === 0) i += 1;
  const collected: string[] = [];
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) break;
    if (/^#{1,6}\s/.test(line)) break;
    if (line.trimStart().startsWith("```")) break;
    const stripped = line
      .trim()
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+\.\s+/, "");
    collected.push(stripped);
    i += 1;
  }
  if (collected.length === 0) return null;
  return collected.join(" ");
}

// ---------- section blocks ----------

type SectionKind =
  | "scope-in"
  | "scope-out"
  | "risks"
  | "open-questions"
  | "decisions"
  | "architecture"
  | "thesis"
  | "generic";

interface SectionBlock {
  readonly heading: string;
  readonly kind: SectionKind;
  /** Up to 3 leading paragraphs of body prose. */
  readonly paragraphs: readonly string[];
  /** First bullet list (up to 7 items). */
  readonly bullets: readonly string[];
  /** Total bullets in that first list (may exceed `bullets.length`). */
  readonly totalBullets: number;
  /** `###` subsection names. */
  readonly subsections: readonly string[];
  /** Fenced code blocks preserved verbatim — diagrams, schemas, SQL. */
  readonly codeBlocks: readonly { lang: string; body: string }[];
}

const MAX_PARAGRAPHS = 3;
const MAX_BULLETS = 7;
const MAX_SUBSECTIONS = 8;
const MAX_CODE_BLOCKS = 4;

/**
 * Walk H2 sections in spec order. Return a structured block per
 * section (excluding `## Goal`, which is rendered separately).
 */
function extractSections(spec: string): readonly SectionBlock[] {
  const lines = spec.split("\n");
  const h2: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+\S/.test(lines[i] ?? "")) h2.push(i);
  }

  const blocks: SectionBlock[] = [];
  for (let k = 0; k < h2.length; k += 1) {
    const start = h2[k] ?? 0;
    const end = h2[k + 1] ?? lines.length;
    const heading = (
      /^##\s+(.+?)\s*$/.exec(lines[start] ?? "")?.[1] ?? ""
    ).trim();
    if (heading === "" || /^goal$/i.test(heading)) continue;
    blocks.push(parseSectionRegion(heading, lines.slice(start + 1, end)));
  }
  return blocks;
}

function parseSectionRegion(
  heading: string,
  region: readonly string[],
): SectionBlock {
  const paragraphs: string[] = [];
  const subsections: string[] = [];
  const codeBlocks: { lang: string; body: string }[] = [];
  let firstBullets: string[] = [];
  let totalBullets = 0;
  let i = 0;

  while (i < region.length) {
    const line = region[i] ?? "";

    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    // ### subsection — capture name only.
    const sub = /^###\s+(.+?)\s*$/.exec(line);
    if (sub !== null) {
      subsections.push((sub[1] ?? "").trim());
      i += 1;
      continue;
    }

    // Fenced code block — preserve verbatim. The fence may carry a
    // language tag (`text`, `mermaid`, `sql`, `bash`); we keep it
    // for the language hint on the rendered <pre>.
    const fence = /^```(\S*)\s*$/.exec(line.trimStart());
    if (fence !== null) {
      const lang = fence[1] ?? "";
      const bodyLines: string[] = [];
      i += 1;
      while (i < region.length && !/^```\s*$/.test(region[i] ?? "")) {
        bodyLines.push(region[i] ?? "");
        i += 1;
      }
      // skip closing fence (or EOF)
      if (i < region.length) i += 1;
      if (codeBlocks.length < MAX_CODE_BLOCKS) {
        codeBlocks.push({ lang, body: bodyLines.join("\n") });
      }
      continue;
    }

    // Bullet list (- / * / + or N.).
    if (/^(?:[-*+]|\d+\.)\s/.test(line.trim())) {
      const collected: string[] = [];
      while (i < region.length) {
        const bl = region[i] ?? "";
        if (bl.trim().length === 0) break;
        if (/^#{1,6}\s/.test(bl)) break;
        if (bl.trimStart().startsWith("```")) break;
        const m = /^(?:[-*+]|\d+\.)\s+(.+)$/.exec(bl.trim());
        if (m === null) break;
        collected.push((m[1] ?? "").trim());
        i += 1;
      }
      if (firstBullets.length === 0) {
        firstBullets = collected.slice(0, MAX_BULLETS);
        totalBullets = collected.length;
      }
      continue;
    }

    // Otherwise treat as paragraph: consume non-blank, non-heading,
    // non-fence, non-list lines.
    if (paragraphs.length < MAX_PARAGRAPHS) {
      const para: string[] = [];
      while (i < region.length) {
        const pl = region[i] ?? "";
        if (pl.trim().length === 0) break;
        if (/^#{1,6}\s/.test(pl)) break;
        if (pl.trimStart().startsWith("```")) break;
        if (/^(?:[-*+]|\d+\.)\s/.test(pl.trim())) break;
        para.push(pl.trim());
        i += 1;
      }
      if (para.length > 0) paragraphs.push(para.join(" "));
    } else {
      i += 1; // paragraph cap reached; just advance
    }
  }

  return {
    heading,
    kind: classifyHeading(heading),
    paragraphs,
    bullets: firstBullets,
    totalBullets,
    subsections: subsections.slice(0, MAX_SUBSECTIONS),
    codeBlocks,
  };
}

function classifyHeading(heading: string): SectionKind {
  const h = heading.toLowerCase().trim();
  if (/(?:^|\b)(?:non[- ]?goals?|out of scope|not in scope)\b/.test(h))
    return "scope-out";
  if (
    /(?:^|\b)(?:in[- ]scope)\b|^(?:\d+\.\s+)?scope$|^(?:\d+\.\s+)?scope and/.test(
      h,
    )
  )
    return "scope-in";
  if (/(?:^|\b)(?:risks?|failure modes?|concerns?|threats?)\b/.test(h))
    return "risks";
  if (/(?:^|\b)(?:open questions?|unresolved|tbd)\b|^faq$/.test(h))
    return "open-questions";
  if (/(?:^|\b)decisions?\b/.test(h)) return "decisions";
  if (
    /(?:^|\b)(?:architecture|system (?:design|architecture)|detailed design)\b|^design$/.test(
      h,
    )
  )
    return "architecture";
  if (/(?:^|\b)(?:product thesis|thesis)\b|^overview$/.test(h)) return "thesis";
  return "generic";
}

// ---------- changelog (provenance) ----------

/**
 * Count `## vX.Y — date` entries in changelog.md. Used only for the
 * provenance footer ("Synthesized via N review rounds"). The full
 * round timeline is intentionally not rendered as a major section —
 * it's process metadata, not spec content.
 */
function countRounds(changelog: string): number {
  const HEADING = /^##\s+v\d+(?:\.\d+){1,2}\s+[—–-]\s+/;
  let n = 0;
  for (const line of changelog.split("\n")) if (HEADING.test(line)) n += 1;
  return n;
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
  return `${res.adapter}/${res.model_id}`;
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
  readonly sections: readonly SectionBlock[];
  readonly publishedAt: string;
  readonly publishedVersion: string;
  readonly coupledFallback: boolean;
  readonly rounds: number;
  readonly leadLabel: string;
  readonly reviewerALabel: string;
  readonly reviewerBLabel: string;
  readonly now: string;
}

function renderBody(args: RenderBodyArgs): string {
  return [
    `<body>`,
    `<main class="brief">`,
    renderHero(args),
    args.coupledFallback ? renderFallbackBanner() : "",
    renderGoal(args.goal),
    args.sections.map((s) => renderSection(s)).join("\n"),
    renderProvenance(args),
    `</main>`,
    `</body>`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function renderHero(args: RenderBodyArgs): string {
  return [
    `<header class="brief-hero">`,
    `<p class="brief-kicker">Brief — derivative summary</p>`,
    `<h1 class="brief-title">${escapeHtml(args.title)}</h1>`,
    `<p class="brief-subtitle">`,
    `<code>${escapeHtml(args.slug)}</code> ·`,
    ` Version ${escapeHtml(args.publishedVersion)} ·`,
    ` Published <time>${escapeHtml(args.publishedAt)}</time> ·`,
    ` <a href="./SPEC.md">canonical SPEC.md →</a>`,
    `</p>`,
    `<p class="brief-warning">`,
    `Summary, not the spec. Skim this for shape, architecture, scope, ` +
      `risks, decisions, and open questions in 5–10 minutes; consult ` +
      `<a href="./SPEC.md">SPEC.md</a> for the full text.`,
    `</p>`,
    `</header>`,
  ].join("\n");
}

function renderFallbackBanner(): string {
  return (
    `<p class="brief-fallback" role="note">⚠️ Coupled fallback recorded — ` +
    `one or more reviewer adapters ran below policy. See SPEC §11.</p>`
  );
}

function renderGoal(goal: string): string {
  return [
    `<section class="brief-goal">`,
    `<h2>Goal</h2>`,
    `<p>${escapeAndInline(goal)}</p>`,
    `</section>`,
  ].join("\n");
}

function renderSection(s: SectionBlock): string {
  const kindClass = `brief-section-${s.kind}`;
  const parts: string[] = [
    `<section class="brief-section ${kindClass}">`,
    `<h2>${escapeHtml(s.heading)}</h2>`,
  ];
  for (const p of s.paragraphs) parts.push(`<p>${escapeAndInline(p)}</p>`);
  if (s.bullets.length > 0)
    parts.push(renderBullets(s.bullets, s.totalBullets));
  for (const c of s.codeBlocks) parts.push(renderCodeBlock(c.lang, c.body));
  if (s.subsections.length > 0) parts.push(renderSubsections(s.subsections));
  if (
    s.paragraphs.length === 0 &&
    s.bullets.length === 0 &&
    s.codeBlocks.length === 0 &&
    s.subsections.length === 0
  ) {
    parts.push(`<p class="brief-empty">See SPEC.md for this section.</p>`);
  }
  parts.push(`</section>`);
  return parts.join("\n");
}

function renderBullets(bullets: readonly string[], total: number): string {
  const items = bullets.map((b) => `<li>${escapeAndInline(b)}</li>`).join("\n");
  const more =
    total > bullets.length
      ? `<li class="brief-more">…${String(total - bullets.length)} more in SPEC.md</li>`
      : "";
  return `<ul>\n${items}${more === "" ? "" : `\n${more}`}\n</ul>`;
}

function renderCodeBlock(lang: string, body: string): string {
  // Diagrams (`text`, `mermaid`, ASCII boxes) and code samples must
  // survive the brief intact. `<pre><code>` keeps whitespace exact.
  const safeLang = /^[a-z0-9_-]{0,20}$/i.test(lang) ? lang : "";
  const cls = safeLang === "" ? "" : ` class="language-${safeLang}"`;
  return `<pre${safeLang === "" ? "" : ` data-lang="${safeLang}"`}><code${cls}>${escapeHtml(body)}</code></pre>`;
}

function renderSubsections(subs: readonly string[]): string {
  const items = subs.map((s) => `<li>${escapeHtml(s)}</li>`).join("\n");
  return [
    `<details class="brief-subsections">`,
    `<summary>Subsections (${String(subs.length)})</summary>`,
    `<ol>${items}</ol>`,
    `</details>`,
  ].join("\n");
}

function renderProvenance(args: RenderBodyArgs): string {
  const roundsLine =
    args.rounds === 0
      ? "no review rounds recorded"
      : `${String(args.rounds)} review ${args.rounds === 1 ? "round" : "rounds"}`;
  return [
    `<footer class="brief-provenance">`,
    `<p>`,
    `Generated by <code>samospec brief ${escapeHtml(args.slug)}</code> on ` +
      `<time>${escapeHtml(args.now)}</time>.`,
    ` ${escapeHtml(roundsLine)} —`,
    ` lead ${escapeHtml(args.leadLabel)},`,
    ` reviewers ${escapeHtml(args.reviewerALabel)} +`,
    ` ${escapeHtml(args.reviewerBLabel)}.`,
    `</p>`,
    `<p>Re-run after each <code>samospec publish</code> to refresh. ` +
      `Canonical document: <a href="./SPEC.md">SPEC.md</a>.</p>`,
    `</footer>`,
  ].join("\n");
}

// ---------- security ----------

/**
 * HTML-escape user-derived strings before interpolating into output.
 * The spec body is git-versioned and reviewed but escape
 * unconditionally — defense in depth.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escape, then convert inline markdown emphasis / code to HTML. The
 * order matters: escaping first means malicious raw HTML in the spec
 * never reaches the output, and the resulting `<strong>` / `<em>` /
 * `<code>` tags are ones we control.
 *
 * Code spans are extracted into placeholders before bold/italic
 * processing so emphasis markers inside backticks are not consumed.
 */
function escapeAndInline(s: string): string {
  let r = escapeHtml(s);
  const codes: string[] = [];
  // Pull code spans into placeholders before bold/italic processing
  // so emphasis markers inside backticks are not consumed. The
  // sentinel is a high-entropy ASCII string that markdown authors
  // are vanishingly unlikely to write by hand.
  const open = "__SAMOSPEC_CODE_";
  const close = "_END__";
  r = r.replace(/`([^`\n]+)`/g, (_m, inner: string) => {
    codes.push(inner);
    return `${open}${String(codes.length - 1)}${close}`;
  });
  r = r.replace(
    /\*\*([^*\n]+?)\*\*/g,
    (_m, inner: string) => `<strong>${inner}</strong>`,
  );
  r = r.replace(
    /(?<!\*)\*(?!\s)([^*\n]+?)\*(?!\*)/g,
    (_m, inner: string) => `<em>${inner}</em>`,
  );
  const restoreRe = new RegExp(`${open}(\\d+)${close}`, "g");
  r = r.replace(
    restoreRe,
    (_m, idx: string) => `<code>${codes[Number(idx)] ?? ""}</code>`,
  );
  return r;
}

// ---------- styles ----------

// Embedded CSS keeps BRIEF.html portable: opening it from a file://
// URL on a colleague's laptop must produce the same render as a
// Pages deploy. No external fonts (offline reading), no JS (single
// static artifact), system font stack.
const BRIEF_CSS = `
:root {
  --bg: #fdfdfc; --fg: #1a1a1a; --muted: #5a5a5a; --accent: #2547a3;
  --card-bg: #f4f3ef; --rule: #d8d6d1;
  --warn-bg: #fff4d4; --warn-fg: #4a3500;
  --risk-bg: #fdecea; --risk-fg: #6a1f15;
  --open-bg: #ecf0fb; --open-fg: #1d3a82;
  --scope-out-bg: #f3eef6; --scope-out-fg: #4a2a63;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
.brief { max-width: 820px; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
.brief-kicker {
  text-transform: uppercase; letter-spacing: 0.08em;
  font-size: 0.78rem; color: var(--muted); margin: 0 0 0.4rem;
}
.brief-title { font-size: 2.1rem; line-height: 1.15; margin: 0 0 0.6rem; }
.brief-subtitle { color: var(--muted); margin: 0 0 1.2rem; }
.brief-subtitle code {
  background: var(--card-bg); padding: 0.05em 0.35em; border-radius: 3px;
}
.brief-warning {
  background: var(--card-bg); border-left: 3px solid var(--accent);
  padding: 0.7rem 0.95rem; margin: 0 0 1.5rem; font-size: 0.92rem;
}
.brief-fallback {
  background: var(--warn-bg); color: var(--warn-fg);
  border: 1px solid #e3c878; border-radius: 4px;
  padding: 0.7rem 0.95rem; margin: 0 0 1.5rem; font-size: 0.92rem;
}
.brief-section, .brief-goal {
  margin: 2rem 0;
  padding-top: 1.2rem;
  border-top: 1px solid var(--rule);
}
.brief-section h2, .brief-goal h2 {
  font-size: 1.35rem; margin: 0 0 0.6rem;
}
.brief-section p, .brief-goal p { margin: 0 0 0.7rem; }
.brief-section ul { margin: 0 0 0.8rem; padding-left: 1.4rem; }
.brief-section ul li { margin: 0 0 0.25rem; }
.brief-section .brief-more { color: var(--muted); list-style: none; margin-left: -1.4rem; }
.brief-section pre {
  background: #f6f4ee; border: 1px solid var(--rule);
  border-radius: 4px; padding: 0.75rem 0.9rem;
  overflow-x: auto; font-size: 0.88rem; line-height: 1.4;
  margin: 0 0 0.8rem;
}
.brief-section pre code { background: none; padding: 0; }
.brief-subsections { margin: 0.5rem 0 0.8rem; font-size: 0.95rem; }
.brief-subsections > summary { cursor: pointer; color: var(--muted); }
.brief-subsections ol { margin: 0.4rem 0 0; padding-left: 1.4rem; }
.brief-section-scope-out { background: var(--scope-out-bg); color: var(--scope-out-fg); padding: 0.9rem 1rem; border-radius: 4px; border-top: none; }
.brief-section-risks { background: var(--risk-bg); color: var(--risk-fg); padding: 0.9rem 1rem; border-radius: 4px; border-top: none; }
.brief-section-open-questions { background: var(--open-bg); color: var(--open-fg); padding: 0.9rem 1rem; border-radius: 4px; border-top: none; }
.brief-section-scope-out h2::before { content: "Out of scope · "; opacity: 0.7; }
.brief-section-scope-out h2 { display: none; }
.brief-section-scope-out::before {
  content: "Out of scope"; display: block; font-weight: 600; font-size: 1.35rem; margin-bottom: 0.5rem;
}
.brief-empty { color: var(--muted); font-style: italic; }
.brief-provenance {
  margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--rule);
  color: var(--muted); font-size: 0.84rem;
}
.brief-provenance p { margin: 0 0 0.4rem; }
a { color: var(--accent); }
code {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.92em;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15171c; --fg: #e6e6e6; --muted: #9a9a9a; --accent: #8ab4ff;
    --card-bg: #21242b; --rule: #2c2f37;
    --warn-bg: #3a3215; --warn-fg: #ffe49a;
    --risk-bg: #3a1f1a; --risk-fg: #ffb1a4;
    --open-bg: #1f2a4a; --open-fg: #b8c8ff;
    --scope-out-bg: #2c1f3a; --scope-out-fg: #d2b8ee;
  }
  .brief-section pre { background: #1c1f25; }
}
@media print {
  .brief { max-width: none; padding: 0; }
  .brief-warning, .brief-fallback, .brief-section { break-inside: avoid; }
}
`.trim();
