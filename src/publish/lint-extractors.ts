// Copyright 2026 Nikolay Samokhvalov.

/**
 * Pure extractors used by `publishLint`. Each function is input-only
 * (string) and returns position-annotated candidates — no filesystem,
 * no repo state. Keeping these pure lets the lint be unit-tested with a
 * corpus of edge cases (SPEC §14 inclusion + exclusion rules).
 *
 * SPEC §14 path extraction rules:
 *   (a) fenced code blocks (any language)
 *   (b) backtick-wrapped strings containing `/` OR matching a known
 *       extension: `.md|.json|.ts|.js|.sql|.py|.rs|.go|.yaml|.yml|.toml|.sh`
 *   (c) bulleted lines under section headers suffix-named
 *       `Files` / `Layout` / `Storage` (case-insensitive suffix match
 *       per spec "or similar — suffix-match on section titles")
 *
 * SPEC §14 excluded-from-path rules (always rejected, both inside and
 * outside backticks):
 *   - URLs (http / https)
 *   - version-number-like strings: `v1.2.3`, `0.1.0`, `1.0`
 *   - bare dotted prose with no slash and no known extension
 *     (`e.g.`, `example.com`, `foo.bar.baz`, `example.com.au`)
 */

/** Extensions that turn a backticked token into a path candidate. */
const PATH_EXTENSIONS = [
  "md",
  "json",
  "ts",
  "js",
  "sql",
  "py",
  "rs",
  "go",
  "yaml",
  "yml",
  "toml",
  "sh",
] as const;

/**
 * Ends with `.<known-ext>` (case-sensitive per shell/file conventions).
 * Trailing punctuation like `.` / `,` / `)` is stripped before match.
 */
const EXTENSION_RE = new RegExp(`\\.(?:${PATH_EXTENSIONS.join("|")})$`);

/**
 * Version-number-like strings (rejected from path extraction):
 *   - `v` prefix optional
 *   - at least two dot-separated digit groups
 *   - overall pattern: ^v?\d+(\.\d+){1,}$
 */
const VERSION_LIKE_RE = /^v?\d+(?:\.\d+){1,}$/;

/** URL-looking tokens (rejected from path extraction). */
const URL_RE = /^https?:\/\//i;

/** Fence open/close line — captures the language tag. */
const FENCE_RE = /^```([A-Za-z0-9+#-]*)\s*$/;

/** Section headers `## Files` / `### State Storage` / `## Layout`. */
const SECTION_HEADER_RE = /^(#{1,6})\s+(.+?)\s*$/;

/** Keyword suffixes that trigger path-in-bullet extraction (case-insensitive). */
const PATH_SECTION_SUFFIXES = ["files", "layout", "storage"] as const;

/** Strip wrapping punctuation commonly surrounding a path in prose. */
function stripTrailingPunctuation(s: string): string {
  return s.replace(/[.,;:!?)\]>]+$/u, "");
}

/**
 * A token is a URL (external reference, never a repo-relative path).
 */
function isUrl(token: string): boolean {
  return URL_RE.test(token);
}

/**
 * A token is version-number-like (e.g. `v1.2.3`, `0.1.0`).
 */
function isVersionLike(token: string): boolean {
  return VERSION_LIKE_RE.test(token);
}

/** Known extension: does the token end with `.<one of PATH_EXTENSIONS>`? */
function hasKnownExtension(token: string): boolean {
  return EXTENSION_RE.test(token);
}

/** Does the token plausibly reference a file path? */
function looksLikePath(token: string): boolean {
  if (token.length === 0) return false;
  if (isUrl(token)) return false;
  if (isVersionLike(token)) return false;
  // Rule (b): backtick-wrapped strings containing `/` or known extension.
  if (token.includes("/")) return true;
  if (hasKnownExtension(token)) return true;
  return false;
}

export interface PathExtraction {
  readonly path: string;
  readonly line: number;
  readonly source: "fenced" | "backtick" | "bullet-section";
}

/**
 * Extract candidate file paths from a spec string.
 *
 * Returns unique (by path) candidates preserving the first-seen line
 * location. See module comment for the inclusion / exclusion rules.
 */
export function extractPaths(spec: string): readonly PathExtraction[] {
  const lines = spec.split("\n");
  const seen = new Map<string, PathExtraction>();

  let inFence = false;
  let currentSection = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      // Rule (a): any non-empty fenced line is scanned for path-like tokens.
      // Whitespace-split — tokens that look like paths (per `looksLikePath`)
      // are captured. Multiple per line possible (e.g. inline comments).
      for (const rawToken of line.split(/\s+/)) {
        const token = stripWrappers(rawToken);
        if (!looksLikePath(token)) continue;
        if (!seen.has(token)) {
          seen.set(token, { path: token, line: lineNo, source: "fenced" });
        }
      }
      continue;
    }

    const headerMatch = SECTION_HEADER_RE.exec(line);
    if (headerMatch) {
      const title = (headerMatch[2] ?? "").trim().toLowerCase();
      // Suffix-insensitive match per SPEC §14 "or similar — suffix-match".
      if (PATH_SECTION_SUFFIXES.some((suf) => title.endsWith(suf))) {
        currentSection = "path-section";
      } else {
        currentSection = "";
      }
      continue;
    }

    // Rule (c): bullet under a path-ish section.
    if (currentSection === "path-section") {
      const bulletMatch = /^\s*-\s+(.+?)\s*$/.exec(line);
      if (bulletMatch) {
        for (const rawToken of (bulletMatch[1] ?? "").split(/\s+/)) {
          const token = stripWrappers(rawToken);
          if (!looksLikePath(token)) continue;
          if (!seen.has(token)) {
            seen.set(token, {
              path: token,
              line: lineNo,
              source: "bullet-section",
            });
          }
        }
        continue;
      }
    }

    // Rule (b): every backticked span in the line.
    for (const token of scanBacktickedTokens(line)) {
      if (!looksLikePath(token)) continue;
      if (!seen.has(token)) {
        seen.set(token, { path: token, line: lineNo, source: "backtick" });
      }
    }
  }

  return [...seen.values()];
}

/**
 * Yield every backtick-wrapped token on a line. We use a simple regex
 * since specs are small; the extractor is idempotent under nesting
 * because we only look at the innermost `...` pair.
 */
function scanBacktickedTokens(line: string): string[] {
  const tokens: string[] = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    tokens.push(m[1] ?? "");
  }
  return tokens;
}

/** Strip common wrapping characters (backticks, quotes, trailing `,`, `)`). */
function stripWrappers(raw: string): string {
  let s = raw.trim();
  // Drop leading / trailing backticks, single quotes, double quotes.
  s = s.replace(/^[`'"]+/, "").replace(/[`'"]+$/, "");
  s = stripTrailingPunctuation(s);
  return s;
}

// -------- Commands ----------------------------------------------------

/** Shell language tags eligible for command scanning. */
const SHELL_FENCES = new Set(["bash", "sh", "shell"]);

export interface CommandExtraction {
  readonly command: string;
  readonly line: number;
}

/**
 * Extract the first token of every non-blank, non-comment line inside
 * `bash` / `sh` / `shell` fenced blocks. Fences with no language tag or
 * with other languages (`ts`, `js`, `json`) are NOT scanned.
 *
 * Shell prompts (`$ `, `# `) and comment lines (`# ...`) are skipped.
 */
export function extractCommands(spec: string): readonly CommandExtraction[] {
  const lines = spec.split("\n");
  const out: CommandExtraction[] = [];

  let inShellFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const tag = (fenceMatch[1] ?? "").toLowerCase();
      if (inShellFence) {
        inShellFence = false;
      } else {
        inShellFence = SHELL_FENCES.has(tag);
      }
      continue;
    }

    if (!inShellFence) continue;

    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Comment line (shell `# comment`).
    if (trimmed.startsWith("#")) continue;

    // Strip optional prompt prefix (`$ ` for unprivileged, `# ` was already
    // rejected above as a comment — privileged-root prompt is never mixed
    // with actual commands in our spec corpus).
    const afterPrompt = trimmed.startsWith("$ ")
      ? trimmed.slice(2).trimStart()
      : trimmed;

    const first = afterPrompt.split(/\s+/)[0] ?? "";
    if (first.length === 0) continue;
    // Skip remaining prompt/comment sentinels that survived trimming.
    if (first === "$" || first === "#") continue;

    out.push({ command: first, line: lineNo });
  }

  return out;
}

// -------- Branch refs --------------------------------------------------

/**
 * Branch-like tokens — backticked names that either
 *   (1) match `<word>/<slug>` (e.g. `samospec/refunds`, `feature/xyz`),
 *   (2) are a bare short name (`main`, `develop`), or
 *   (3) include slashes but are NOT plausibly file paths.
 *
 * File-looking tokens (ending in a known extension, or containing `.`
 * before the final path segment) are filtered out so the caller can
 * keep path warnings separate from ghost-branch warnings.
 */
export interface BranchRefExtraction {
  readonly branch: string;
  readonly line: number;
}

/** Set of bare short names we treat as plausible branch references. */
const BARE_BRANCH_WORDS = new Set(["main", "master", "develop", "trunk"]);

/**
 * A backticked token is "branchy" if:
 *   - not a URL
 *   - not a known file extension
 *   - not a version-like string
 *   - AND either `<word>/<word>` shape OR in the bare-branch set.
 *
 * Token shape allows slashes, alphanumerics, `-`, `_`, `.` in segments.
 */
const BRANCHY_PAIR_RE = /^[A-Za-z][\w-]*\/[\w./-]+$/;
const BARE_IDENT_RE = /^[A-Za-z][\w-]*$/;

function looksLikeBranch(token: string): boolean {
  if (token.length === 0) return false;
  if (isUrl(token)) return false;
  if (isVersionLike(token)) return false;
  if (hasKnownExtension(token)) return false;
  if (BRANCHY_PAIR_RE.test(token)) return true;
  if (BARE_IDENT_RE.test(token) && BARE_BRANCH_WORDS.has(token)) return true;
  return false;
}

export function extractBranchRefs(
  spec: string,
): readonly BranchRefExtraction[] {
  const lines = spec.split("\n");
  const seen = new Map<string, BranchRefExtraction>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    for (const token of scanBacktickedTokens(line)) {
      if (!looksLikeBranch(token)) continue;
      if (!seen.has(token)) {
        seen.set(token, { branch: token, line: lineNo });
      }
    }
  }
  return [...seen.values()];
}

// -------- Adapter / model refs -----------------------------------------

/**
 * Extract adapter/model-looking identifiers. v1 patterns:
 *   - `claude-<family>-<n>-<n>` (e.g. `claude-opus-4-7`, `claude-sonnet-4-6`)
 *   - `gpt-<major>.<minor>-<family>(-<suffix>)?` (e.g. `gpt-5.1-codex`,
 *     `gpt-5.1-codex-max`)
 *
 * The regex is tight enough to avoid capturing ordinary prose and loose
 * enough to catch the four name shapes we ship today plus minor variants.
 * False positives here are cheap — drift warnings are soft.
 */
const ADAPTER_CLAUDE_RE = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*-\d+(?:-\d+)+$/;
const ADAPTER_GPT_RE = /^gpt-\d+(?:\.\d+)+-[a-z]+(?:-[a-z0-9]+)*$/;

export interface AdapterRefExtraction {
  readonly model: string;
  readonly line: number;
}

function looksLikeAdapterModel(token: string): boolean {
  return ADAPTER_CLAUDE_RE.test(token) || ADAPTER_GPT_RE.test(token);
}

export function extractAdapterRefs(
  spec: string,
): readonly AdapterRefExtraction[] {
  const lines = spec.split("\n");
  const seen = new Map<string, AdapterRefExtraction>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    // Scan backticked tokens first — spec style favors quoting model names.
    for (const token of scanBacktickedTokens(line)) {
      if (looksLikeAdapterModel(token) && !seen.has(token)) {
        seen.set(token, { model: token, line: lineNo });
      }
    }
    // Then scan bare-word tokens for unbackticked mentions.
    for (const rawToken of line.split(/\s+/)) {
      const token = stripWrappers(rawToken);
      if (looksLikeAdapterModel(token) && !seen.has(token)) {
        seen.set(token, { model: token, line: lineNo });
      }
    }
  }
  return [...seen.values()];
}
