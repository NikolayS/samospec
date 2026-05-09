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

/** Stable URL fragment from a section heading. */
function slugifyId(heading: string): string {
  return (
    "s-" +
    heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
  );
}

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
    `<div class="progress" aria-hidden="true"><i id="pb"></i></div>`,
    renderMetabar(args),
    `<main class="brief">`,
    renderHero(args),
    args.coupledFallback ? renderFallbackBanner() : "",
    renderToc(args.sections),
    renderGoal(args.goal),
    args.sections.map((s, i) => renderSection(s, i + 2)).join("\n"),
    renderProvenance(args),
    `</main>`,
    `<script>${BRIEF_JS}</script>`,
    `</body>`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

function renderMetabar(args: RenderBodyArgs): string {
  const dateSlice =
    args.publishedAt === "—"
      ? args.now.slice(0, 10)
      : args.publishedAt.slice(0, 10);
  return [
    `<header class="metabar">`,
    `<div class="metabar-row">`,
    `<div class="metabar-left">`,
    `<span class="brand">${escapeHtml(args.slug)}</span>`,
    `<span class="chip">v<b>${escapeHtml(args.publishedVersion)}</b></span>`,
    `<span class="chip">${escapeHtml(dateSlice)}</span>`,
    `</div>`,
    `<div class="metabar-right">`,
    `<span class="status">brief</span>`,
    `<span class="theme-sw" role="group" aria-label="Theme">`,
    `<button data-v="light" title="Light">&#9728;</button>`,
    `<button data-v="dark" title="Dark">&#9790;</button>`,
    `<button data-v="auto" title="System" class="active">&#9680;</button>`,
    `</span>`,
    `</div>`,
    `</div>`,
    `</header>`,
  ].join("\n");
}

function renderToc(sections: readonly SectionBlock[]): string {
  const entries: string[] = [
    `<li><a href="#s-goal"><span class="num">01</span><span>Goal</span></a></li>`,
  ];
  sections.forEach((s, i) => {
    const num = String(i + 2).padStart(2, "0");
    const id = slugifyId(s.heading);
    entries.push(
      `<li><a href="#${id}"><span class="num">${num}</span>` +
        `<span>${escapeHtml(s.heading)}</span></a></li>`,
    );
  });
  return [
    `<nav class="brief-toc">`,
    `<div class="brief-toc-title">In this brief</div>`,
    `<ol>`,
    entries.join("\n"),
    `</ol>`,
    `</nav>`,
  ].join("\n");
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
    `<p class="brief-fallback" role="note">Coupled fallback recorded — ` +
    `one or more reviewer adapters ran below policy. See SPEC §11.</p>`
  );
}

function renderGoal(goal: string): string {
  return [
    `<section class="brief-goal" id="s-goal">`,
    `<h2><span class="n">01</span><span>Goal</span></h2>`,
    `<p>${escapeAndInline(goal)}</p>`,
    `</section>`,
  ].join("\n");
}

function renderSection(s: SectionBlock, num: number): string {
  const kindClass = `brief-section-${s.kind}`;
  const id = slugifyId(s.heading);
  const numStr = String(num).padStart(2, "0");
  const parts: string[] = [
    `<section class="brief-section ${kindClass}" id="${id}">`,
    `<h2><span class="n">${numStr}</span><span>${escapeHtml(s.heading)}</span></h2>`,
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
// Pages deploy. No external fonts (offline reading), system mono stack.
const BRIEF_CSS = `
:root {
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --fs: 15px; --lh: 1.5rem; --measure: 88ch;
  --paper: #faf7f0; --paper-2: #f3efe4; --paper-3: #ebe6d6;
  --ink: #1a1714; --ink-2: #4a443c; --ink-3: #847b6a;
  --rule: #d8d0bc; --rule-2: #c2b89e;
  --grid: rgba(26,23,20,0.045);
  --accent: #1f6f3f; --accent-soft: #e6f0e0;
  --ok: #1f6f3f; --ok-bg: #e6f0e0;
  --warn: #a85a07; --warn-bg: #f5e8d0;
  --bad: #9b2226; --bad-bg: #f3dfdc;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #14110d; --paper-2: #1c1814; --paper-3: #25201a;
    --ink: #ece4d3; --ink-2: #b9b0a0; --ink-3: #7a7263;
    --rule: #2f2a23; --rule-2: #423c33;
    --grid: rgba(236,228,211,0.04);
    --accent: #6fcf8a; --accent-soft: #1d2c20;
    --ok: #6fcf8a; --ok-bg: #1d2c20;
    --warn: #e0a14a; --warn-bg: #2c2317;
    --bad: #e07a7d; --bad-bg: #2a1c1c;
  }
}
[data-theme="dark"] {
  --paper: #14110d; --paper-2: #1c1814; --paper-3: #25201a;
  --ink: #ece4d3; --ink-2: #b9b0a0; --ink-3: #7a7263;
  --rule: #2f2a23; --rule-2: #423c33;
  --grid: rgba(236,228,211,0.04);
  --accent: #6fcf8a; --accent-soft: #1d2c20;
  --ok: #6fcf8a; --ok-bg: #1d2c20;
  --warn: #e0a14a; --warn-bg: #2c2317;
  --bad: #e07a7d; --bad-bg: #2a1c1c;
}
[data-theme="light"] {
  --paper: #faf7f0; --paper-2: #f3efe4; --paper-3: #ebe6d6;
  --ink: #1a1714; --ink-2: #4a443c; --ink-3: #847b6a;
  --rule: #d8d0bc; --rule-2: #c2b89e;
  --grid: rgba(26,23,20,0.045);
  --accent: #1f6f3f; --accent-soft: #e6f0e0;
  --ok: #1f6f3f; --ok-bg: #e6f0e0;
  --warn: #a85a07; --warn-bg: #f5e8d0;
  --bad: #9b2226; --bad-bg: #f3dfdc;
}
*,*::before,*::after { box-sizing: border-box; }
html,body { margin: 0; padding: 0; }
body {
  font-family: var(--mono);
  font-size: var(--fs); line-height: var(--lh);
  color: var(--ink); background: var(--paper);
  text-rendering: optimizeLegibility;
  background-image: linear-gradient(
    to bottom,
    transparent calc(var(--lh) - 1px),
    var(--grid) calc(var(--lh) - 1px)
  );
  background-size: 100% var(--lh);
}
::selection { background: var(--accent); color: var(--paper); }
a { color: var(--ink); text-decoration: underline; text-underline-offset: 0.18em;
    text-decoration-thickness: 1px; text-decoration-color: var(--rule-2); }
a:hover { color: var(--accent); text-decoration-color: var(--accent); }
p,ul,ol,pre,details { margin: 0 0 var(--lh); }
ul { padding-left: 3ch; list-style: none; }
ul > li::before { content: "\\2500\\00a0"; color: var(--ink-3);
                  margin-left: -3ch; display: inline-block; width: 3ch; }
ol { padding-left: 3ch; }
li { margin: 0; }
strong,b { font-weight: 700; }
em,i { font-style: normal; color: var(--accent); }
code,samp {
  font-family: var(--mono); font-size: 0.92em;
  background: var(--paper-2); border: 1px solid var(--rule);
  padding: 0 0.4ch; border-radius: 2px;
}
pre code { background: none; border: 0; padding: 0; font-size: 1em; }
h1,h2,h3 { font-weight: 700; margin: 0 0 var(--lh); line-height: var(--lh); }
h1 { font-size: 1.8rem; line-height: calc(var(--lh) * 2); }
h2 { font-size: 1.1rem; }
h3 { font-size: 1rem; color: var(--ink-2); font-weight: 600; }
/* reading progress */
.progress {
  position: fixed; top: 0; left: 0; right: 0; height: 2px;
  z-index: 60; background: transparent; pointer-events: none;
}
.progress > i { display: block; height: 100%; width: 0%;
                background: var(--accent); transition: width 80ms linear; }
/* sticky metabar */
.metabar {
  position: sticky; top: 0; z-index: 50;
  background: var(--paper); border-bottom: 1px solid var(--rule);
}
.metabar-row {
  max-width: var(--measure); margin: 0 auto; padding: 0 2ch;
  display: flex; align-items: center;
  height: calc(var(--lh) * 2); font-size: 0.85rem; gap: 2ch;
}
.metabar-left { display: flex; align-items: center; flex: 1 1 auto;
                min-width: 0; white-space: nowrap; overflow: hidden; }
.metabar-left .brand { font-weight: 700; color: var(--ink); padding-right: 1.5ch; }
.metabar-left .chip { color: var(--ink-2); padding: 0 1.5ch;
                      border-left: 1px solid var(--rule); }
.metabar-left .chip b { color: var(--ink); font-weight: 600; }
.metabar-right { display: flex; align-items: center; gap: 1.5ch; flex: 0 0 auto; }
.metabar .status { color: var(--ink-3); white-space: nowrap; }
.theme-sw { display: inline-flex; border: 1px solid var(--rule-2);
            border-radius: 3px; overflow: hidden;
            height: calc(var(--lh) * 1.1); }
.theme-sw button {
  background: transparent; border: 0; border-right: 1px solid var(--rule);
  cursor: pointer; font-family: var(--mono); font-size: 0.95rem;
  color: var(--ink-3); padding: 0 1.1ch;
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 3ch;
}
.theme-sw button:last-child { border-right: 0; }
.theme-sw button:hover { background: var(--paper-2); color: var(--ink); }
.theme-sw button.active { background: var(--ink); color: var(--paper); }
@media (max-width: 600px) {
  .metabar .status { display: none; }
  .metabar-left .chip:nth-of-type(2) { display: none; }
}
/* page */
.brief {
  max-width: var(--measure); margin: 0 auto;
  padding: calc(var(--lh) * 2) 2ch calc(var(--lh) * 4);
}
/* hero */
.brief-hero {
  margin-bottom: calc(var(--lh) * 1.5);
  border-bottom: 1px solid var(--rule); padding-bottom: var(--lh);
}
.brief-kicker {
  font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--ink-3); margin: 0 0 0.5rem;
}
.brief-title { font-size: 2rem; line-height: calc(var(--lh) * 2);
               margin: 0 0 calc(var(--lh) * 0.5); }
.brief-subtitle { color: var(--ink-2); margin: 0 0 var(--lh); font-size: 0.9rem; }
.brief-subtitle code { font-size: 0.9em; }
.brief-warning {
  color: var(--ink-2); border-left: 2px solid var(--accent);
  padding-left: 1.5ch; margin: var(--lh) 0 0; font-size: 0.92rem;
}
.brief-fallback {
  background: var(--warn-bg); color: var(--warn);
  border: 1px solid var(--rule-2); border-radius: 2px;
  padding: calc(var(--lh) * 0.5) 1.5ch;
  margin: 0 0 var(--lh); font-size: 0.9rem;
}
/* table of contents */
.brief-toc {
  margin: 0 0 calc(var(--lh) * 1.5);
  padding: var(--lh) 2ch; border: 1px solid var(--rule);
  background: var(--paper-2);
}
.brief-toc-title {
  font-size: 0.8rem; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--ink-3); margin-bottom: 0.5rem;
}
.brief-toc ol {
  display: grid; grid-template-columns: repeat(auto-fit,minmax(20ch,1fr));
  gap: 0 2ch; margin: 0; padding-left: 0; list-style: none;
}
.brief-toc li::before { content: ""; }
.brief-toc a {
  display: flex; gap: 1ch; padding: 2px 1ch;
  text-decoration: none; color: var(--ink-2);
  border-left: 2px solid transparent; margin-left: -1ch;
}
.brief-toc a .num { color: var(--ink-3); min-width: 3ch; }
.brief-toc a:hover { color: var(--ink); background: var(--paper-3);
                     border-left-color: var(--rule-2); }
/* sections */
.brief-goal,
.brief-section {
  scroll-margin-top: calc(var(--lh) * 3);
  margin-bottom: calc(var(--lh) * 1.5);
  border-top: 1px solid var(--rule); padding-top: var(--lh);
}
.brief-goal h2,
.brief-section h2 {
  display: flex; gap: 1ch; align-items: baseline; margin: 0 0 var(--lh);
}
.brief-goal h2 .n,
.brief-section h2 .n {
  color: var(--ink-3); font-weight: 500; font-size: 0.88rem;
  min-width: 3ch; letter-spacing: 0.05em;
}
.brief-empty { color: var(--ink-3); font-style: italic; }
.brief-more { list-style: none; }
.brief-more::before { content: "" !important; }
pre {
  background: var(--paper-2); border: 1px solid var(--rule);
  border-radius: 2px; padding: var(--lh) 2ch;
  overflow-x: auto; font-size: 0.88em;
  line-height: calc(var(--lh) * 0.9); margin: 0 0 var(--lh);
}
.brief-subsections { margin: 0 0 var(--lh); }
.brief-subsections > summary { cursor: pointer; color: var(--ink-3); padding: 0.25rem 0; }
.brief-subsections ol { margin: 0.5rem 0 0; padding-left: 3ch; }
/* section kind variants */
.brief-section-scope-out {
  background: var(--paper-2); border-top-color: transparent;
  border-left: 3px solid var(--rule-2);
  margin-left: -2ch; padding-left: calc(2ch - 3px); border-radius: 2px;
}
.brief-section-risks {
  background: var(--bad-bg); border-top-color: transparent;
  border-left: 3px solid var(--bad);
  margin-left: -2ch; padding-left: calc(2ch - 3px); border-radius: 2px;
}
.brief-section-risks h2 .n { color: var(--bad); }
.brief-section-open-questions {
  background: var(--paper-2); border-top-color: transparent;
  border-left: 3px solid var(--accent);
  margin-left: -2ch; padding-left: calc(2ch - 3px); border-radius: 2px;
}
.brief-section-open-questions h2 .n { color: var(--accent); }
/* provenance */
.brief-provenance {
  margin-top: calc(var(--lh) * 2); padding-top: var(--lh);
  border-top: 1px solid var(--rule);
  color: var(--ink-3); font-size: 0.85rem;
}
.brief-provenance p { margin: 0 0 0.5rem; }
.brief-provenance a { color: var(--ink-2); }
.brief-provenance code { font-size: 0.9em; }
@media print {
  .progress,.metabar { display: none; }
  .brief { max-width: none; padding: 0; }
  .brief-goal,.brief-section { break-inside: avoid; }
}
`.trim();

// Minimal JS: theme toggle (light/dark/auto) + reading-progress bar.
// Kept tiny and inline so BRIEF.html remains a single portable artifact.
const BRIEF_JS = `(function(){
var r=document.documentElement,bs=document.querySelectorAll('.theme-sw button');
var s=localStorage.getItem('brief-theme')||'auto';
function apply(v){r.dataset.theme=v==='auto'?'':v;
  bs.forEach(function(b){b.classList.toggle('active',b.dataset.v===v);});}
apply(s);
bs.forEach(function(b){b.addEventListener('click',function(){
  var v=b.dataset.v||'auto';localStorage.setItem('brief-theme',v);apply(v);});});
var bar=document.getElementById('pb');
if(bar){var upd=function(){var m=document.body.scrollHeight-window.innerHeight;
  bar.style.width=(m>0?window.scrollY/m*100:0)+'%';};
  window.addEventListener('scroll',upd,{passive:true});upd();}
})();`.trim();
