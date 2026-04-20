// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §7 — deterministic gist cache.
 *
 * - Cache directory: `.samospec/cache/gists/<blob-sha>.md`
 * - Key: git blob hash (sha1("blob <bytes>\0<content>")) — survives
 *   branch switches & rebases; auto-invalidates on content change
 *   because a new blob SHA means a new cache file.
 * - Zero model tokens: gists are built from path / size / line count /
 *   authored date + cheap imports/exports regexes. Model-generated
 *   gists are a Sprint 3 concern; this module leaves the seam but
 *   does not implement it.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const GIST_CACHE_REL = path.join(".samospec", "cache", "gists");

/**
 * Compute the git blob SHA for a file's content. Matches
 *   printf 'blob %d\0%s' <size> <content> | sha1sum
 * (and thus `git hash-object <path>`). Implemented locally so no
 * filesystem round-trip is required.
 */
export function computeBlobSha(content: string): string {
  const buf = Buffer.from(content, "utf8");
  const hash = createHash("sha1");
  hash.update(`blob ${String(buf.length)}\0`);
  hash.update(buf);
  return hash.digest("hex");
}

export interface ImportsExports {
  readonly imports: readonly string[];
  readonly exports: readonly string[];
}

/**
 * Cheap, regex-based imports/exports parser. Returns `[]` for
 * unsupported languages rather than running an AST; the gist's job is
 * to give an LLM signal without costing real budget.
 */
export function parseImportsExports(
  content: string,
  filePath: string,
): ImportsExports {
  const lower = filePath.toLowerCase();
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(lower)) {
    return parseTsImportsExports(content);
  }
  if (/\.py$/.test(lower)) {
    return parsePyImports(content);
  }
  if (/\.rs$/.test(lower)) {
    return parseRsUseItems(content);
  }
  if (/\.go$/.test(lower)) {
    return parseGoImports(content);
  }
  return { imports: [], exports: [] };
}

function parseTsImportsExports(content: string): ImportsExports {
  const imports = new Set<string>();
  const exports = new Set<string>();

  const importRe =
    /import\s+(?:[^;'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const m of content.matchAll(importRe)) {
    imports.add(m[1] ?? "");
  }
  // export const / function / class / default
  const exportRe =
    /^\s*export\s+(?:(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+)(\w+)/gm;
  for (const m of content.matchAll(exportRe)) {
    if (m[1]) exports.add(m[1]);
  }

  return { imports: [...imports], exports: [...exports] };
}

function parsePyImports(content: string): ImportsExports {
  const imports = new Set<string>();
  const importRe = /^\s*(?:import|from)\s+([\w.]+)/gm;
  for (const m of content.matchAll(importRe)) {
    if (m[1]) imports.add(m[1]);
  }
  return { imports: [...imports], exports: [] };
}

function parseRsUseItems(content: string): ImportsExports {
  const imports = new Set<string>();
  const useRe = /^\s*use\s+([\w:]+)/gm;
  for (const m of content.matchAll(useRe)) {
    if (m[1]) imports.add(m[1]);
  }
  // `pub fn` / `pub struct` / `pub enum` / `pub use` are surfaceable
  // exports. Keep cheap.
  const exports = new Set<string>();
  const pubRe = /^\s*pub\s+(?:fn|struct|enum|mod|const|static)\s+(\w+)/gm;
  for (const m of content.matchAll(pubRe)) {
    if (m[1]) exports.add(m[1]);
  }
  return { imports: [...imports], exports: [...exports] };
}

function parseGoImports(content: string): ImportsExports {
  const imports = new Set<string>();
  const singleRe = /^\s*import\s+"([^"]+)"/gm;
  for (const m of content.matchAll(singleRe)) {
    if (m[1]) imports.add(m[1]);
  }
  const groupRe = /import\s*\(([^)]*)\)/gs;
  for (const m of content.matchAll(groupRe)) {
    for (const inner of (m[1] ?? "").matchAll(/"([^"]+)"/g)) {
      if (inner[1]) imports.add(inner[1]);
    }
  }
  return { imports: [...imports], exports: [] };
}

export interface BuildDeterministicGistArgs {
  readonly path: string;
  readonly content: string;
  readonly blobSha: string;
  readonly authoredAt: number | undefined;
}

/**
 * Render a deterministic gist Markdown fragment. Deterministic means
 * the output is a pure function of the inputs — the same inputs yield
 * byte-identical text. This is load-bearing for the blob-sha cache.
 */
export function buildDeterministicGist(
  args: BuildDeterministicGistArgs,
): string {
  const bytes = Buffer.byteLength(args.content, "utf8");
  const lineCount = countLines(args.content);
  const date =
    args.authoredAt !== undefined
      ? isoDate(args.authoredAt)
      : "(unknown)";
  const { imports, exports } = parseImportsExports(args.content, args.path);

  const lines: string[] = [];
  lines.push(`# Gist — \`${args.path}\``);
  lines.push("");
  lines.push(`- path: \`${args.path}\``);
  lines.push(`- blob ${args.blobSha}`);
  lines.push(`- bytes: ${String(bytes)}`);
  lines.push(`- lines: ${String(lineCount)}`);
  lines.push(`- last authored: ${date}`);

  if (imports.length > 0) {
    lines.push("");
    lines.push("## Imports");
    lines.push("");
    for (const imp of imports) {
      lines.push(`- \`${imp}\``);
    }
  }

  if (exports.length > 0) {
    lines.push("");
    lines.push("## Exports");
    lines.push("");
    for (const exp of exports) {
      lines.push(`- \`${exp}\``);
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Count "lines" the way humans count them: a file ending in a single
 * trailing newline counts that newline as a terminator of the last
 * content line (not as its own empty line). An empty string is 0.
 */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  const parts = content.split("\n");
  // If the content ends with "\n", split yields a trailing empty string
  // that shouldn't count.
  if (content.endsWith("\n")) return parts.length - 1;
  return parts.length;
}

function isoDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const iso = d.toISOString();
  // YYYY-MM-DD prefix.
  return iso.slice(0, 10);
}

/**
 * Absolute filesystem path for the blob-keyed gist cache entry.
 */
export function gistCachePath(repoPath: string, blobSha: string): string {
  return path.join(repoPath, GIST_CACHE_REL, `${blobSha}.md`);
}

export interface ReadOrCreateGistArgs {
  readonly repoPath: string;
  readonly path: string;
  readonly content: string;
  readonly authoredAt: number | undefined;
}

export interface ReadOrCreateGistResult {
  readonly gist: string;
  readonly blobSha: string;
  readonly cacheFile: string;
  readonly fromCache: boolean;
}

/**
 * Return the cached gist for `content`, creating & persisting it when
 * absent. Cache lookup is keyed by the computed blob SHA so repeated
 * discovery calls amortize to zero work. Survives branch switches and
 * rebases: as long as the content bytes are identical, the cache is
 * valid.
 */
export function readOrCreateGist(
  args: ReadOrCreateGistArgs,
): ReadOrCreateGistResult {
  const blobSha = computeBlobSha(args.content);
  const cacheFile = gistCachePath(args.repoPath, blobSha);
  if (existsSync(cacheFile)) {
    const gist = readFileSync(cacheFile, "utf8");
    return { gist, blobSha, cacheFile, fromCache: true };
  }
  const gistArgs: BuildDeterministicGistArgs = {
    path: args.path,
    content: args.content,
    blobSha,
    authoredAt: args.authoredAt,
  };
  const gist = buildDeterministicGist(gistArgs);
  mkdirSync(path.dirname(cacheFile), { recursive: true });
  writeFileSync(cacheFile, gist, "utf8");
  return { gist, blobSha, cacheFile, fromCache: false };
}
