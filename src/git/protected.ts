// Copyright 2026 Nikolay Samokhvalov.

import { spawnSync } from "node:child_process";

/**
 * Hardcoded protected-branch list. SPEC §5 Phase 1.
 * Extensible only by adding to this file — the user config
 * `git.protected_branches` layers on top (additive, never subtractive).
 */
export const HARDCODED_PROTECTED_BRANCHES: readonly string[] = [
  "main",
  "master",
  "develop",
  "trunk",
];

export interface UserConfig {
  readonly git?: {
    readonly protected_branches?: readonly string[];
  };
}

export interface IsProtectedOpts {
  /**
   * Absolute path to the git working tree. When absent, `git config` is read
   * using the process working directory. Tests always set this explicitly.
   */
  readonly repoPath?: string;
  /**
   * Parsed `.samo/config.json` contents (or any object shape subset).
   * The `git.protected_branches` array is additive.
   */
  readonly userConfig?: UserConfig;
}

/**
 * Returns true if the given branch name should be treated as protected.
 *
 * Combines three local sources with OR (per SPEC §5 Phase 1, bullet "Local
 * sources"):
 *   1. Hardcoded list ({@link HARDCODED_PROTECTED_BRANCHES}).
 *   2. `git config branch.<name>.protected` truthy.
 *   3. User config `git.protected_branches` array membership.
 *
 * Remote API probe is deliberately NOT consulted here. SPEC §14 keeps
 * `git.remote_probe` off by default to avoid audit-log entries. Local checks
 * are "sufficient for safety" per SPEC §5 Phase 1.
 *
 * Per SPEC §8 / §13 test 2: a `false` value in the git config NEVER weakens
 * a hardcoded or user-config protection. The three sources combine additively.
 */
export function isProtected(
  branchName: string,
  opts: IsProtectedOpts = {},
): boolean {
  if (HARDCODED_PROTECTED_BRANCHES.includes(branchName)) return true;

  const userList = opts.userConfig?.git?.protected_branches ?? [];
  if (userList.includes(branchName)) return true;

  if (readGitConfigBranchProtected(branchName, opts.repoPath)) return true;

  return false;
}

function readGitConfigBranchProtected(
  branchName: string,
  repoPath: string | undefined,
): boolean {
  // `git config --get` exits 1 when the key is absent — that's the common case.
  const args = ["config", "--get", `branch.${branchName}.protected`];
  const result = spawnSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
  });
  if (result.status !== 0) return false;
  const value = (result.stdout ?? "").trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

/**
 * Source label used in the canonical protected-branch refusal string.
 * Matches the vocabulary introduced by PR #132 (issue #126):
 *   - `"built-in default"` when the branch is in
 *     {@link HARDCODED_PROTECTED_BRANCHES}.
 *   - `"config"` when the branch is only protected via user config
 *     (`.samo/config.json → git.protected_branches`) or git's
 *     `branch.<name>.protected` setting.
 */
export type ProtectedBranchSource = "built-in default" | "config";

/**
 * Returns the source label for a branch that is known to be protected.
 *
 * Call sites typically already know the branch is protected (they are
 * formatting a refusal); this helper only classifies the source.
 */
export function protectedBranchSource(
  branchName: string,
): ProtectedBranchSource {
  return HARDCODED_PROTECTED_BRANCHES.includes(branchName)
    ? "built-in default"
    : "config";
}

/**
 * Formats the canonical post-#126 / #132 refusal string emitted when a
 * `samospec` commit (from `new`, `iterate`, or `resume`) would otherwise
 * land on a protected branch.
 *
 * Extracted per issue #142 to dedupe three call sites that were drifting
 * on wording (pre-#126 bare form vs post-#126 sourced form).
 *
 * Shape: `samospec: refusing to commit on protected branch '<branch>'
 * (<source>). Check out samospec/<slug> and re-run.`
 */
export function formatProtectedBranchError(
  branch: string,
  slug: string,
  source: ProtectedBranchSource,
): string {
  return (
    `samospec: refusing to commit on protected branch ` +
    `'${branch}' (${source}). ` +
    `Check out samospec/${slug} and re-run.`
  );
}
