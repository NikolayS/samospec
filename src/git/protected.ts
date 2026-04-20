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
