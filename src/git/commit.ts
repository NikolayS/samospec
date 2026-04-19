// Copyright 2026 Nikolay Samokhvalov.

import { spawnSync } from "node:child_process";

import { currentBranch } from "./branch.ts";
import { GitLayerUsageError, ProtectedBranchError } from "./errors.ts";
import { isProtected, type UserConfig } from "./protected.ts";

/**
 * Commit actions from SPEC §8 + §6. `user-edit` is the changelog slug used
 * when the user hand-edits SPEC.md between rounds. `changelog` covers the
 * version-bump-only side commits.
 */
export const COMMIT_ACTIONS = [
  "draft",
  "refine",
  "publish",
  "user-edit",
  "changelog",
] as const;
export type CommitAction = (typeof COMMIT_ACTIONS)[number];

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Version: N.N[.N] or similar dotted numerics — "0.1", "1.0", "0.3.1".
const VERSION_RE = /^\d+(?:\.\d+)*$/;

export interface BuildCommitMessageArgs {
  readonly slug: string;
  readonly action: CommitAction;
  readonly version: string;
  /**
   * For `refine` actions only. When set, the message becomes
   * `spec(<slug>): refine v<version> after review r<roundNumber>`.
   */
  readonly roundNumber?: number;
}

/**
 * Builds the SPEC §8 commit message:
 *   - `spec(<slug>): <action> v<version>`
 *   - `spec(<slug>): refine v<version> after review r<n>` when roundNumber set.
 *
 * Throws {@link GitLayerUsageError} on any grammar violation. Callers pass
 * raw components; only this helper is allowed to format the message — no
 * ad-hoc string interpolation elsewhere.
 */
export function buildCommitMessage(args: BuildCommitMessageArgs): string {
  if (!SLUG_RE.test(args.slug)) {
    throw new GitLayerUsageError(
      `slug '${args.slug}' is invalid. Use lowercase letters, digits, ` +
        `and '-' (no leading/trailing '-').`,
    );
  }
  if (!COMMIT_ACTIONS.includes(args.action)) {
    throw new GitLayerUsageError(
      `action '${String(args.action)}' is not in the grammar. Known ` +
        `actions: ${COMMIT_ACTIONS.join(", ")}.`,
    );
  }
  if (!VERSION_RE.test(args.version)) {
    throw new GitLayerUsageError(
      `version '${args.version}' is invalid. Expected dotted numerics ` +
        `(e.g. '0.1', '1.0', '0.3.1'). Leading 'v' is added by the ` +
        `message template — do not pass it in.`,
    );
  }
  if (args.roundNumber !== undefined) {
    if (!Number.isInteger(args.roundNumber) || args.roundNumber < 0) {
      throw new GitLayerUsageError(
        `roundNumber '${String(args.roundNumber)}' must be a non-negative ` +
          `integer.`,
      );
    }
    return `spec(${args.slug}): ${args.action} v${args.version} after review r${String(
      args.roundNumber,
    )}`;
  }
  return `spec(${args.slug}): ${args.action} v${args.version}`;
}

export interface SpecCommitArgs extends BuildCommitMessageArgs {
  readonly repoPath: string;
  readonly paths: readonly string[];
  readonly userConfig?: UserConfig;
}

/**
 * Stages the given paths (explicit list — never `add -A`) and creates a
 * commit with the SPEC §8 message. Refuses with exitCode 2 if the current
 * branch is protected.
 *
 * Deliberate constraints:
 *   - No `--force`, no `+refspec`, no `--no-verify`, no `--amend`. Anywhere.
 *     The safety test in `tests/git/no-force.test.ts` greps the built source
 *     to catch regressions.
 */
export function specCommit(args: SpecCommitArgs): void {
  if (args.paths.length === 0) {
    throw new GitLayerUsageError(
      "specCommit requires a non-empty 'paths' array. Use an explicit list " +
        "(no 'add -A' anywhere in the git layer).",
    );
  }

  const branch = currentBranch(args.repoPath);
  if (
    isProtected(branch, {
      repoPath: args.repoPath,
      ...(args.userConfig ? { userConfig: args.userConfig } : {}),
    })
  ) {
    throw new ProtectedBranchError(branch);
  }

  // Build the message FIRST — validates grammar before touching the index.
  const message = buildCommitMessage(args);

  runGitOrThrow(["add", "--", ...args.paths], args.repoPath);
  runGitOrThrow(["commit", "-m", message], args.repoPath);
}

function runGitOrThrow(
  gitArgs: readonly string[],
  repoPath: string,
): { readonly stdout: string; readonly stderr: string } {
  const result = spawnSync("git", gitArgs as string[], {
    cwd: repoPath,
    encoding: "utf8",
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `git ${gitArgs.join(" ")} failed with status ${String(result.status)}: ${
        result.stderr ?? ""
      }`,
    );
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
