// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §7 — context discovery entry point.
 *
 * Wires together:
 *   git ls-files ∪ git ls-files --others --exclude-standard
 *     -> symlink safety
 *     -> hard-coded no-read list
 *     -> default denylist + .samospec-ignore
 *     -> batched git log (file → last-authored-at)
 *     -> rank
 *     -> per-phase budget
 *     -> large-file truncation
 *     -> deterministic gist for excluded files
 *     -> untrusted-data envelope for included files
 *     -> context.json provenance
 */

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_CONTEXT_BUDGETS,
  estimateTokens,
  fitFilesToBudget,
  type ContextBudgets,
} from "./budget.ts";
import { wrap } from "./envelope.ts";
import { computeBlobSha, readOrCreateGist } from "./gist.ts";
import { collectAuthorDates } from "./git-meta.ts";
import { applyIgnore, loadSamospecIgnore } from "./ignore.ts";
import {
  contextJsonPath,
  writeContextJson,
  type ContextJson,
  type FileEntry,
  type RiskFlag,
} from "./provenance.ts";
import { rankFiles } from "./rank.ts";
import {
  classifyTruncateKind,
  LARGE_FILE_LINE_THRESHOLD,
  truncateContent,
} from "./truncate.ts";

export type ContextPhase = ContextJson["phase"];

interface LoadedFile {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
  readonly blob: string;
  readonly authoredAt: number | undefined;
  readonly riskFlags: RiskFlag[];
}

export interface DiscoverContextArgs {
  readonly repoPath: string;
  readonly slug: string;
  readonly phase: ContextPhase;
  readonly contextPaths: readonly string[];
  /** Optional budget overrides for testing / the --context-budget flag. */
  readonly budgets?: ContextBudgets;
}

export interface DiscoverContextResult {
  readonly context: ContextJson;
  /** One envelope-wrapped chunk per included file, in rank order. */
  readonly chunks: readonly string[];
}

/**
 * Run the full pipeline. Reads from the filesystem, writes
 * `.samospec/spec/<slug>/context.json`, populates the gist cache at
 * `.samospec/cache/gists/`, and returns the `ContextJson` + the
 * ready-to-ship chunks.
 */
export function discoverContext(
  args: DiscoverContextArgs,
): DiscoverContextResult {
  const budgets = args.budgets ?? DEFAULT_CONTEXT_BUDGETS;
  const phaseBudget = budgets[phaseToBudget(args.phase)];

  // 1. Candidate set: tracked ∪ untracked-but-not-ignored.
  const raw = listTrackedAndUntracked(args.repoPath);
  // 2. Symlink safety: drop anything whose realpath escapes the repo.
  const onRoot = refuseOutboundSymlinks(args.repoPath, raw);
  // 3. Ignore overlay (which first applies the no-read list).
  const samoIgnore = loadSamospecIgnore(args.repoPath);
  const surviving = applyIgnore({
    repoPath: args.repoPath,
    paths: onRoot,
    extraPatterns: samoIgnore,
  });

  // 4. Batched git log -> author-date map.
  const { map: authorDates } = collectAuthorDates({
    repoPath: args.repoPath,
  });

  // 5. Rank (bucket + authordate).
  const ranked = rankFiles({
    paths: surviving,
    authorDates,
    contextPaths: args.contextPaths,
  });

  // 6. Load content, apply large-file truncation, track risk flags.
  const loaded: LoadedFile[] = [];
  for (const r of ranked) {
    const full = path.join(args.repoPath, r.path);
    let rawBuf: Buffer;
    try {
      rawBuf = readFileSync(full);
    } catch {
      continue; // skip files that vanished mid-pipeline
    }
    const isBinary = looksBinary(rawBuf);
    const riskFlags: RiskFlag[] = [];
    if (isBinary) {
      // Should not happen — ignore overlay already drops binaries — but
      // defensive: flag + skip so nothing binary makes it to an envelope.
      riskFlags.push("binary_excluded");
      continue;
    }
    const content = rawBuf.toString("utf8");
    const lineCount = content.split("\n").length;
    let processed = content;
    if (lineCount > LARGE_FILE_LINE_THRESHOLD) {
      const tr = truncateContent({
        path: r.path,
        content,
        kind: classifyTruncateKind(r.path),
        recentHunks: [], // Sprint 3 hook: real blame integration
      });
      processed = tr.content;
      if (tr.truncated) riskFlags.push("large_file_truncated");
    }
    const blob = computeBlobSha(processed);
    loaded.push({
      path: r.path,
      content: processed,
      bytes: Buffer.byteLength(processed, "utf8"),
      blob,
      authoredAt: r.authoredAt,
      riskFlags,
    });
  }

  // 7. Budget: fit included set; excluded files become gists.
  const plan = fitFilesToBudget({
    files: loaded.map((l) => ({ path: l.path, content: l.content })),
    budgetTokens: phaseBudget,
  });
  const includedSet = new Set(plan.included.map((f) => f.path));

  // 8. Build chunks (envelopes) for included files and FileEntry list
  //    for the whole set (included + excluded).
  const chunks: string[] = [];
  const fileEntries: FileEntry[] = [];
  for (const l of loaded) {
    const included = includedSet.has(l.path);
    const entry: FileEntry = included
      ? {
          path: l.path,
          bytes: l.bytes,
          tokens: estimateTokens(l.content),
          blob: l.blob,
          included: true,
          risk_flags: [...l.riskFlags],
        }
      : {
          path: l.path,
          bytes: l.bytes,
          blob: l.blob,
          included: false,
          gist_id: `${l.blob}.md`,
          risk_flags: [...l.riskFlags],
        };
    fileEntries.push(entry);

    if (included) {
      chunks.push(wrap({ path: l.path, content: l.content, blobSha: l.blob }));
    } else {
      // Ensure the deterministic gist cache entry exists.
      readOrCreateGist({
        repoPath: args.repoPath,
        path: l.path,
        content: l.content,
        authoredAt: l.authoredAt,
      });
    }
  }

  // 9. Aggregate top-level risk flags (unique) and write context.json.
  const topRiskFlags = dedupeRiskFlags(
    fileEntries.flatMap((f) => f.risk_flags),
  );
  const ctx: ContextJson = {
    phase: args.phase,
    files: fileEntries,
    risk_flags: topRiskFlags,
    budget: {
      phase: args.phase,
      tokens_used: plan.tokensUsed,
      tokens_budget: plan.tokensBudget,
    },
  };
  writeContextJson(contextJsonPath(args.repoPath, args.slug), ctx);

  return { context: ctx, chunks };
}

function dedupeRiskFlags(all: readonly RiskFlag[]): RiskFlag[] {
  return Array.from(new Set<RiskFlag>(all));
}

function phaseToBudget(phase: ContextPhase): keyof ContextBudgets {
  if (phase === "interview") return "interview";
  if (phase === "revision" || phase === "review_loop") return "revision";
  return "draft";
}

/**
 * Union of `git ls-files` and `git ls-files --others --exclude-standard`.
 * De-duplicated, in original git order (which is stable lexicographic).
 */
export function listTrackedAndUntracked(repoPath: string): readonly string[] {
  const tracked = runGit(repoPath, ["ls-files"]);
  const untracked = runGit(repoPath, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of [...tracked, ...untracked]) {
    if (line === "") continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

function runGit(repoPath: string, args: readonly string[]): string[] {
  const res = spawnSync("git", args as string[], {
    cwd: repoPath,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if ((res.status ?? 1) !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${String(res.status)}): ${
        res.stderr ?? ""
      }`,
    );
  }
  return (res.stdout ?? "").split("\n");
}

/**
 * Drop any candidate whose realpath lives outside `repoPath`. Uses
 * `fs.realpathSync` (resolves symlinks) + string-prefix check against
 * the canonicalized repo root.
 */
export function refuseOutboundSymlinks(
  repoPath: string,
  candidates: readonly string[],
): readonly string[] {
  const rootReal = realpathSync(repoPath);
  const rootWithSep = rootReal.endsWith(path.sep)
    ? rootReal
    : `${rootReal}${path.sep}`;
  const kept: string[] = [];
  for (const rel of candidates) {
    const full = path.join(repoPath, rel);
    try {
      statSync(full);
    } catch {
      // Missing files get dropped silently; callers re-check.
      continue;
    }
    let real: string;
    try {
      real = realpathSync(full);
    } catch {
      // Broken symlink → refuse.
      continue;
    }
    if (real === rootReal) continue;
    if (real.startsWith(rootWithSep)) kept.push(rel);
  }
  return kept;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
