// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §7 — ignore overlay for context discovery.
 *
 * Composition order (highest precedence last):
 *   1. hard-coded no-read list (see ./no-read.ts) — always wins
 *   2. default denylist + asset-size + binary check — built-in
 *   3. `.gitignore` — honored transitively via `git ls-files` (caller
 *      relies on git for the canonical tracked/untracked-unignored set)
 *   4. `.samospec-ignore` — user overlay at repo root
 *
 * `.samospec-ignore` whitelists (`!pattern`) can un-ignore items from
 * layers (2) and (3), but never from layer (1). This is enforced in
 * {@link applyIgnore} by short-circuiting to {@link isNoRead} first.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { isNoRead } from "./no-read.ts";

export const MAX_ASSET_BYTES = 100 * 1024; // SPEC §7: assets >100KB denied.
/** Bytes scanned to decide "looks binary". A null byte within the window is a
 * strong signal (text files effectively never contain `\u0000`). */
const BINARY_SNIFF_BYTES = 8192;

export interface IgnorePattern {
  /** Original pattern source line (for diagnostics/tests). */
  readonly source: string;
  /** Compiled regex matching normalized POSIX relative paths. */
  readonly regex: RegExp;
  /** When true, a match is a whitelist (un-ignore). */
  readonly negated: boolean;
  /** When true, pattern matches directories only (ends with `/`). */
  readonly dirOnly: boolean;
}

/** SPEC §7 default denylist applied to every discovery. */
export const DEFAULT_DENYLIST: readonly IgnorePattern[] = compilePatterns([
  "node_modules/",
  "vendor/",
  "dist/",
  "build/",
  "*.lock",
  "*.min.*",
  "*.generated.*",
]);

/**
 * Parse a .gitignore-style file into {@link IgnorePattern} records.
 * Blank lines and `#`-prefixed comments are discarded. A leading `\#`
 * is treated as a literal `#`.
 */
export function parseIgnorePatterns(raw: string): readonly IgnorePattern[] {
  const sources: string[] = [];
  for (const rawLine of raw.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) continue;
    // Escape for literal `#` at start.
    const source = trimmed.startsWith("\\#") ? trimmed.slice(1) : trimmed;
    sources.push(source);
  }
  return compilePatterns(sources);
}

function compilePatterns(sources: readonly string[]): readonly IgnorePattern[] {
  return sources.map(compileOne);
}

function compileOne(source: string): IgnorePattern {
  let rest = source;
  let negated = false;
  if (rest.startsWith("!")) {
    negated = true;
    rest = rest.slice(1);
  }
  const dirOnly = rest.endsWith("/");
  if (dirOnly) rest = rest.slice(0, -1);
  const anchored = rest.startsWith("/");
  if (anchored) rest = rest.slice(1);

  // Escape regex metachars except our glob wildcards.
  const escaped = rest.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withStars = escaped
    .replace(/\*\*/g, "__DOUBLESTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/__DOUBLESTAR__/g, ".*");

  // When anchored: must start at root. When not anchored: may appear at
  // root or after any `/` boundary (gitignore semantics).
  const leftAnchor = anchored ? "^" : "(^|/)";
  const rightAnchor = dirOnly ? "(/|$)" : "$";
  const regex = new RegExp(`${leftAnchor}${withStars}${rightAnchor}`, "i");
  return { source, regex, negated, dirOnly };
}

/**
 * Load `.samospec-ignore` from the repo root. Returns the empty array
 * when the file is absent.
 */
export function loadSamospecIgnore(
  repoPath: string,
): readonly IgnorePattern[] {
  const file = path.join(repoPath, ".samospec-ignore");
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8");
  return parseIgnorePatterns(raw);
}

export interface ApplyIgnoreArgs {
  readonly repoPath: string;
  readonly paths: readonly string[];
  /** Patterns layered on top of the default denylist. Typically from
   * {@link loadSamospecIgnore}. */
  readonly extraPatterns: readonly IgnorePattern[];
}

/**
 * Apply the full ignore pipeline. Returns the surviving subset of
 * `paths`, in original order.
 */
export function applyIgnore(args: ApplyIgnoreArgs): readonly string[] {
  const patterns: readonly IgnorePattern[] = [
    ...DEFAULT_DENYLIST,
    ...args.extraPatterns,
  ];
  const out: string[] = [];
  for (const raw of args.paths) {
    const p = raw.replaceAll("\\", "/");
    // 1. No-read ALWAYS wins. No whitelist can recover a no-read match.
    if (isNoRead(p)) continue;
    // 2. Size/binary checks (only when the file actually exists on disk).
    if (isTooBigOrBinary(args.repoPath, p)) continue;
    // 3. Pattern pipeline.
    if (isIgnoredByPatterns(p, patterns)) continue;
    out.push(raw);
  }
  return out;
}

function isIgnoredByPatterns(
  p: string,
  patterns: readonly IgnorePattern[],
): boolean {
  let ignored = false;
  for (const pat of patterns) {
    if (pat.regex.test(p)) {
      ignored = pat.negated ? false : true;
    }
  }
  return ignored;
}

function isTooBigOrBinary(repoPath: string, rel: string): boolean {
  const full = path.join(repoPath, rel);
  let st: { size: number };
  try {
    st = statSync(full);
  } catch {
    // Non-existent path: let pattern stage decide. Returning false is
    // safe — nothing happens until discovery reads the file.
    return false;
  }
  if (st.size > MAX_ASSET_BYTES) return true;
  try {
    return looksBinary(full);
  } catch {
    return false;
  }
}

function looksBinary(full: string): boolean {
  // Read at most BINARY_SNIFF_BYTES and search for NUL.
  const buf = readFileSync(full);
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
