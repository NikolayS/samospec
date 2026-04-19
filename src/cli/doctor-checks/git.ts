// Copyright 2026 Nikolay Samokhvalov.

import { CheckStatus, type CheckResult } from "../doctor-format.ts";

export interface CheckGitHealthArgs {
  readonly isGitRepo: () => boolean;
  readonly currentBranch: () => string;
  readonly hasRemote: () => boolean;
  readonly remoteUrl: () => string | null;
  readonly isProtected: () => boolean;
}

/**
 * Pure function — every git probe is injected. Real-process wiring lives
 * at the aggregator level so this is trivially testable without a repo.
 *
 *   - OK   — inside a repo, on a non-protected branch.
 *   - WARN — inside a repo, on a protected branch (informational).
 *   - FAIL — not inside a repo (doctor can't guarantee safety).
 *
 * Remote status is informational per SPEC §10 ("remote configured? —
 * informational only").
 */
export function checkGitHealth(args: CheckGitHealthArgs): CheckResult {
  if (!args.isGitRepo()) {
    return {
      status: CheckStatus.Fail,
      label: "git",
      message: "not a git repository — run `git init` first",
    };
  }

  let branch: string;
  try {
    branch = args.currentBranch();
  } catch (err) {
    return {
      status: CheckStatus.Fail,
      label: "git",
      message: `cannot determine current branch: ${(err as Error).message}`,
    };
  }

  const protectedBranch = args.isProtected();
  const remote = args.hasRemote();
  const url = remote ? args.remoteUrl() : null;

  const pieces: string[] = [`branch ${branch}`];
  if (protectedBranch) pieces.push("protected");
  if (remote) pieces.push(`remote: ${url ?? "(configured)"}`);
  else pieces.push("no remote configured");

  return {
    status: protectedBranch ? CheckStatus.Warn : CheckStatus.Ok,
    label: "git",
    message: pieces.join("; "),
  };
}
