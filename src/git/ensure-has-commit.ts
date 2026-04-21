// Copyright 2026 Nikolay Samokhvalov.

import { spawnSync } from "node:child_process";

export const INITIAL_COMMIT_MESSAGE =
  "chore: initial commit (created by samospec)";

export interface EnsureHasCommitOpts {
  readonly repoPath: string;
}

export interface EnsureHasCommitResult {
  /** True if an initial empty commit was created; false if HEAD already existed. */
  readonly created: boolean;
}

/**
 * Checks whether the repo has at least one commit. If not (empty repo /
 * freshly `git init`), creates an empty initial commit so that operations
 * that require HEAD (e.g. branch creation) can proceed.
 *
 * Logs nothing — the caller is responsible for surfacing the message
 * "No commits found — created initial commit." when `created` is true.
 */
export function ensureHasCommit(
  opts: EnsureHasCommitOpts,
): EnsureHasCommitResult {
  if (hasHead(opts.repoPath)) {
    return { created: false };
  }

  runGitOrThrow(
    ["commit", "--allow-empty", "-m", INITIAL_COMMIT_MESSAGE],
    opts.repoPath,
  );

  return { created: true };
}

function hasHead(repoPath: string): boolean {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoPath,
    encoding: "utf8",
  });
  return result.status === 0;
}

function runGitOrThrow(args: readonly string[], repoPath: string): void {
  const result = spawnSync("git", args as string[], {
    cwd: repoPath,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env["GIT_AUTHOR_NAME"] ?? "samospec",
      GIT_AUTHOR_EMAIL: process.env["GIT_AUTHOR_EMAIL"] ?? "samospec@localhost",
      GIT_COMMITTER_NAME: process.env["GIT_COMMITTER_NAME"] ?? "samospec",
      GIT_COMMITTER_EMAIL:
        process.env["GIT_COMMITTER_EMAIL"] ?? "samospec@localhost",
    },
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with status ${String(result.status)}: ${
        result.stderr ?? ""
      }`,
    );
  }
}
