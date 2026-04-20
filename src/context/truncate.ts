// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §7 — large-file truncation.
 *
 * Files over {@link LARGE_FILE_LINE_THRESHOLD} lines are pre-truncated
 * using a kind-specific policy:
 *
 *   markdown : retain every `#`/`##` header line plus the 50 lines
 *              immediately following (preserves section structure +
 *              intro).
 *   code     : retain the first 100 lines (imports/exports), last 100
 *              lines (typically exports / module bottom), plus any
 *              hunks flagged as "recent blame" (last 30 days).
 *   text     : retain head 100 + tail 100 (cheap default).
 *
 * The returned {@link TruncateResult} exposes both the new content and
 * a `truncated: true` signal. The caller is responsible for flagging
 * `large_file_truncated` in `context.json.risk_flags`.
 *
 * Omitted regions are replaced with a single `... [N lines truncated]`
 * placeholder so downstream readers know content was elided.
 */

export const LARGE_FILE_LINE_THRESHOLD = 1000;
const MARKDOWN_HEADER_FOLLOW_LINES = 50;
const CODE_HEAD_LINES = 100;
const CODE_TAIL_LINES = 100;
const TEXT_HEAD_LINES = 100;
const TEXT_TAIL_LINES = 100;

export type TruncateKind = "markdown" | "code" | "text";

export interface BlameHunk {
  /** 0-based inclusive start line (aligns with the JS string-split
   * array the truncator walks). Callers translating from `git blame`
   * output (which is 1-based) must subtract 1 before constructing. */
  readonly startLine: number;
  /** 0-based inclusive end line. */
  readonly endLine: number;
}

export interface TruncateContentArgs {
  readonly path: string;
  readonly content: string;
  readonly kind: TruncateKind;
  readonly recentHunks: readonly BlameHunk[];
}

export interface TruncateResult {
  readonly truncated: boolean;
  readonly content: string;
}

/**
 * Decide the per-file truncation. Files ≤ threshold are returned
 * untouched (but still flagged `truncated: false`). No IO.
 */
export function truncateContent(args: TruncateContentArgs): TruncateResult {
  const lines = args.content.split("\n");
  if (lines.length <= LARGE_FILE_LINE_THRESHOLD) {
    return { truncated: false, content: args.content };
  }

  const keep = new Set<number>(); // 0-based line indices retained
  switch (args.kind) {
    case "markdown":
      keepMarkdownHeaders(lines, keep);
      break;
    case "code":
      keepCodeHeadTailAndHunks(lines, args.recentHunks, keep);
      break;
    case "text":
      keepHeadTail(lines, TEXT_HEAD_LINES, TEXT_TAIL_LINES, keep);
      break;
  }

  return { truncated: true, content: renderKept(lines, keep) };
}

function keepMarkdownHeaders(lines: string[], keep: Set<number>): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^#{1,2} /.test(line) || /^#{1,2}$/.test(line)) {
      const end = Math.min(lines.length, i + MARKDOWN_HEADER_FOLLOW_LINES + 1);
      for (let j = i; j < end; j++) keep.add(j);
    }
  }
}

function keepHeadTail(
  lines: string[],
  head: number,
  tail: number,
  keep: Set<number>,
): void {
  const headEnd = Math.min(lines.length, head);
  for (let i = 0; i < headEnd; i++) keep.add(i);
  const tailStart = Math.max(0, lines.length - tail);
  for (let i = tailStart; i < lines.length; i++) keep.add(i);
}

function keepCodeHeadTailAndHunks(
  lines: string[],
  hunks: readonly BlameHunk[],
  keep: Set<number>,
): void {
  keepHeadTail(lines, CODE_HEAD_LINES, CODE_TAIL_LINES, keep);
  for (const hunk of hunks) {
    // `startLine`/`endLine` are 0-based inclusive indices into the
    // lines array. Clamp to bounds.
    const start = Math.max(0, hunk.startLine);
    const end = Math.min(lines.length - 1, hunk.endLine);
    for (let i = start; i <= end; i++) keep.add(i);
  }
}

/**
 * Render the kept set as an in-order string. Consecutive kept lines
 * are concatenated; each gap between kept ranges is replaced with
 *   ... [<N> lines truncated]
 * so downstream consumers can see the structure.
 */
function renderKept(lines: string[], keep: Set<number>): string {
  const out: string[] = [];
  let inGap = false;
  let gapStart = -1;

  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) {
      if (inGap) {
        const gapLen = i - gapStart;
        out.push(`... [${String(gapLen)} lines truncated]`);
        inGap = false;
      }
      out.push(lines[i] ?? "");
    } else {
      if (!inGap) {
        inGap = true;
        gapStart = i;
      }
    }
  }
  if (inGap) {
    const gapLen = lines.length - gapStart;
    out.push(`... [${String(gapLen)} lines truncated]`);
  }
  return out.join("\n");
}

/**
 * Classify a path into a {@link TruncateKind} based on extension.
 * Unknown extensions fall back to "text".
 */
export function classifyTruncateKind(path: string): TruncateKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".adoc")) return "markdown";
  const codeExts = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".rs",
    ".go",
    ".py",
    ".rb",
    ".java",
    ".kt",
    ".c",
    ".cc",
    ".cpp",
    ".h",
    ".hpp",
    ".cs",
    ".swift",
    ".m",
    ".scala",
    ".php",
    ".sh",
    ".bash",
    ".sql",
  ];
  for (const ext of codeExts) {
    if (lower.endsWith(ext)) return "code";
  }
  return "text";
}
