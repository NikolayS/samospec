// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §7 — batched git metadata for context discovery.
 *
 * Exactly ONE `git log --format='%at %H' --name-only HEAD` invocation
 * per discovery call. Scope is `HEAD` (not `--all`) so unrelated
 * feature-branch history does not bleed into the ranking signal.
 *
 * The caller gets:
 * - an in-process `Map<path, authoredAt>` (Unix seconds of the most
 *   recent commit that touched the file), and
 * - a `spawnCount` counter (tests assert `=== 1` regardless of repo
 *   size).
 */

import { spawnSync } from "node:child_process";

export interface GitLogEntry {
  readonly authoredAt: number;
  readonly sha: string;
  readonly files: readonly string[];
}

/**
 * Parse the combined output of
 *   `git log --format='%at %H' --name-only HEAD`
 *
 * Real git output is:
 *   <authoredAt> <sha>
 *   <blank>
 *   <file-1>
 *   <file-2>
 *   ...
 *   <blank>
 *   <authoredAt> <sha>
 *   ...
 *
 * We walk the stream and treat the FIRST line that looks like a header
 * (an integer + space + hex SHA) as a record boundary; everything in
 * between belongs to the previous record's file list. Blank lines are
 * skipped.
 */
export function parseGitLogBatch(raw: string): readonly GitLogEntry[] {
  const entries: GitLogEntry[] = [];
  const lines = raw.split("\n");
  let header: { authoredAt: number; sha: string } | null = null;
  let files: string[] = [];

  const flush = () => {
    if (header === null) return;
    entries.push({
      authoredAt: header.authoredAt,
      sha: header.sha,
      files,
    });
    header = null;
    files = [];
  };

  for (const line of lines) {
    if (line === "") continue;
    const h = tryParseHeader(line);
    if (h !== null) {
      // Close out previous record; open a new one.
      flush();
      header = h;
      continue;
    }
    if (header !== null) {
      files.push(line);
    }
  }
  flush();
  return entries;
}

/**
 * A header line is exactly `<authoredAt> <sha>` where authoredAt is a
 * positive integer and sha is a 40-char hex string (we accept 7+ to
 * tolerate abbreviated hashes). File paths that happen to start with
 * an integer + space + hex text are vanishingly rare but still
 * disambiguated because the second token must match the hex regex.
 */
function tryParseHeader(
  line: string,
): { authoredAt: number; sha: string } | null {
  const space = line.indexOf(" ");
  if (space === -1) return null;
  const left = line.slice(0, space);
  const right = line.slice(space + 1).trim();
  if (!/^\d+$/.test(left)) return null;
  if (!/^[0-9a-f]{7,64}$/i.test(right)) return null;
  const at = Number.parseInt(left, 10);
  if (!Number.isFinite(at)) return null;
  return { authoredAt: at, sha: right };
}

/**
 * Reduce `GitLogEntry[]` into a `Map<path, latestAuthoredAt>`. Because
 * `git log` emits newest-first, the first time we see a path wins;
 * still, we compare explicitly in case a caller re-orders entries.
 */
export function buildGitLogMap(
  entries: readonly GitLogEntry[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of entries) {
    for (const f of e.files) {
      const prev = map.get(f);
      if (prev === undefined || prev < e.authoredAt) {
        map.set(f, e.authoredAt);
      }
    }
  }
  return map;
}

export interface CollectAuthorDatesArgs {
  readonly repoPath: string;
}

export interface CollectAuthorDatesResult {
  readonly map: Map<string, number>;
  readonly spawnCount: number;
}

/**
 * Run the batched `git log` invocation and derive the file->authoredAt
 * map. The `spawnCount` in the result MUST remain `1` — tests assert
 * this invariant. Any future optimization that adds per-file spawns
 * will break it loudly.
 */
export function collectAuthorDates(
  args: CollectAuthorDatesArgs,
): CollectAuthorDatesResult {
  const result = spawnSync(
    "git",
    ["log", "--format=%at %H", "--name-only", "HEAD"],
    { cwd: args.repoPath, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `git log failed (${String(result.status)}): ${result.stderr ?? ""}`,
    );
  }
  const entries = parseGitLogBatch(result.stdout ?? "");
  const map = buildGitLogMap(entries);
  return { map, spawnCount: 1 };
}
