// Copyright 2026 Nikolay Samokhvalov.

import { spawnSync } from "node:child_process";

import { GitLayerUsageError, ProtectedBranchError } from "./errors.ts";
import { isProtected, type UserConfig } from "./protected.ts";

export const SPEC_BRANCH_PREFIX = "samospec/";

export interface CreateSpecBranchOpts {
  readonly repoPath?: string;
  readonly userConfig?: UserConfig;
}

/**
 * Slug grammar for `samospec/<slug>`. Keep deliberately strict:
 *   - non-empty
 *   - lowercase letters, digits, and `-` only
 *   - may not start or end with `-`
 *
 * Slashes and whitespace are rejected to ensure a 1:1 mapping between slug
 * and branch (no nested `samospec/foo/bar` branches in v1).
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Creates the `samospec/<slug>` spec branch off the CURRENT branch and checks
 * it out. Refuses when the current branch is protected (any source from
 * {@link isProtected}). Refuses when the target branch already exists.
 *
 * Throws {@link ProtectedBranchError} on protected-branch violations
 * (exitCode 2, SPEC §8) and {@link GitLayerUsageError} on slug / uniqueness
 * violations.
 *
 * Returns the fully-qualified branch name on success.
 */
export function createSpecBranch(
  slug: string,
  opts: CreateSpecBranchOpts = {},
): string {
  assertValidSlug(slug);

  const current = currentBranch(opts.repoPath);
  if (isProtected(current, opts)) {
    throw new ProtectedBranchError(current);
  }

  const target = `${SPEC_BRANCH_PREFIX}${slug}`;
  if (branchExists(target, opts.repoPath)) {
    throw new GitLayerUsageError(
      `Branch '${target}' already exists. Choose a different slug or ` +
        `remove the existing branch first.`,
    );
  }

  runGit(["checkout", "-b", target], opts.repoPath);
  return target;
}

function assertValidSlug(slug: string): void {
  if (slug.length === 0) {
    throw new GitLayerUsageError("slug must be non-empty");
  }
  if (!SLUG_RE.test(slug)) {
    throw new GitLayerUsageError(
      `slug '${slug}' is invalid. Use lowercase letters, digits, and '-' ` +
        `(no leading/trailing '-', no slashes, no spaces).`,
    );
  }
}

export function currentBranch(repoPath: string | undefined): string {
  return runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath).stdout.trim();
}

export function branchExists(
  branchName: string,
  repoPath: string | undefined,
): boolean {
  const result = spawnSync(
    "git",
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    { cwd: repoPath, encoding: "utf8" },
  );
  return result.status === 0;
}

function runGit(
  args: readonly string[],
  repoPath: string | undefined,
): { readonly stdout: string; readonly stderr: string } {
  const result = spawnSync("git", args as string[], {
    cwd: repoPath,
    encoding: "utf8",
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed with status ${String(result.status)}: ${
        result.stderr ?? ""
      }`,
    );
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
