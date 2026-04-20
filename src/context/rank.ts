// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §7 — context ranking.
 *
 * Canonical order (highest first):
 *   readme      README.md / README.* / CONTRIBUTING.md
 *   manifest    package.json, Cargo.toml, go.mod, pyproject.toml,
 *               requirements*.txt, Gemfile (lockfiles NOT counted)
 *   arch-docs   ARCHITECTURE.md, docs/**, *.adoc
 *   user-source anything matching `opts.contextPaths`
 *   other       everything else
 *
 * Within a bucket the tie-break is `git authordate` recency ONLY (per
 * SPEC §7 — path shallowness was dropped as a weak signal). When two
 * files share an identical authoredAt (including both missing) the
 * original input order is preserved (stable sort).
 */

import path from "node:path";

export const CONTEXT_BUCKETS = [
  "readme",
  "manifest",
  "arch-docs",
  "user-source",
  "other",
] as const;

export type ContextBucket = (typeof CONTEXT_BUCKETS)[number];

/** Numeric weight — smaller wins (we sort ascending). */
const BUCKET_WEIGHT: Record<ContextBucket, number> = {
  readme: 0,
  manifest: 1,
  "arch-docs": 2,
  "user-source": 3,
  other: 4,
};

const README_BASENAMES = new Set(["readme", "contributing"]);

const MANIFEST_BASENAMES = new Set([
  "package.json",
  "cargo.toml",
  "go.mod",
  "pyproject.toml",
  "gemfile",
]);

const ARCH_BASENAMES = new Set(["architecture.md"]);

/**
 * Classify a single path into a bucket. `contextPaths` is the set of
 * user-selected source directories (e.g. ["src/auth", "src/billing"]).
 */
export function classifyBucket(
  rel: string,
  contextPaths: readonly string[],
): ContextBucket {
  const posix = rel.replaceAll("\\", "/");
  const lower = posix.toLowerCase();
  const base = path.posix.basename(lower);
  const basename = base.replace(/\.[^.]+$/, "");

  // README.* / CONTRIBUTING.md (any directory depth).
  if (README_BASENAMES.has(base) || README_BASENAMES.has(basename)) {
    return "readme";
  }

  // Manifest files (top-level semantics; the important ones are all in the
  // repo root or a subpackage root, but we still match by basename to catch
  // monorepos). Lockfiles are explicitly excluded (their basenames end
  // with `.lock` or `-lock.json`).
  if (MANIFEST_BASENAMES.has(base)) {
    return "manifest";
  }
  if (/^requirements(?:-[a-z0-9]+)?\.txt$/.test(base)) {
    return "manifest";
  }

  // Architecture & top-level docs.
  if (ARCH_BASENAMES.has(base)) return "arch-docs";
  if (lower.startsWith("docs/")) return "arch-docs";
  if (base.endsWith(".adoc")) return "arch-docs";

  // User-selected source dirs.
  for (const ctx of contextPaths) {
    const prefix = ctx.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
    if (lower === prefix || lower.startsWith(`${prefix}/`)) {
      return "user-source";
    }
  }

  return "other";
}

export interface RankFilesArgs {
  readonly paths: readonly string[];
  readonly authorDates: ReadonlyMap<string, number>;
  readonly contextPaths: readonly string[];
}

export interface RankedFile {
  readonly path: string;
  readonly bucket: ContextBucket;
  readonly authoredAt: number | undefined;
}

/**
 * Rank paths into a stable order: bucket first, then authoredAt
 * descending (newer wins). Files without an authored-at date sort to
 * the end of their bucket (but preserve input order amongst themselves).
 */
export function rankFiles(args: RankFilesArgs): readonly RankedFile[] {
  const enriched: Array<{
    readonly idx: number;
    readonly file: RankedFile;
  }> = args.paths.map((p, idx) => ({
    idx,
    file: {
      path: p,
      bucket: classifyBucket(p, args.contextPaths),
      authoredAt: args.authorDates.get(p),
    },
  }));

  enriched.sort((a, b) => {
    const bw = BUCKET_WEIGHT[a.file.bucket] - BUCKET_WEIGHT[b.file.bucket];
    if (bw !== 0) return bw;
    // Newer first within the same bucket. Undefined sorts last.
    const ad = a.file.authoredAt;
    const bd = b.file.authoredAt;
    if (ad === bd) return a.idx - b.idx; // stable
    if (ad === undefined) return 1;
    if (bd === undefined) return -1;
    return bd - ad;
  });

  return enriched.map((e) => e.file);
}
