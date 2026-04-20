// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §8 — `pushBranch` helper.
 *
 * Guarantees:
 *   - Never invokes git with a forbidden flag. The only argv shape is
 *     `git push <remote> <branch>` — no refspec manipulation, no force,
 *     no leading-plus push, no hook bypass. The no-force regression test
 *     in `tests/git/no-force.test.ts` greps this source.
 *   - `--no-push` invocation override beats persisted consent: if
 *     `noPush: true`, we never exec git at all.
 *   - Consent refused → no push attempt, state `skipped-refused`.
 *     Consent accepted → push runs, state `pushed` on success,
 *     `failed` on non-zero exit (stderr captured, not thrown — the loop
 *     keeps running local-only).
 */

import { spawnSync } from "node:child_process";

export interface PushBranchOpts {
  readonly repoPath: string;
  readonly remote: string;
  readonly branch: string;
  /** True when the user has accepted push consent (persisted or prompt). */
  readonly granted: boolean;
  /** True when `--no-push` / `--no-commit` is set for this invocation. */
  readonly noPush: boolean;
}

export type PushBranchState =
  | "pushed"
  | "skipped-no-push"
  | "skipped-refused"
  | "failed";

export interface PushBranchResult {
  readonly state: PushBranchState;
  /** stderr / reason when state is `failed`. */
  readonly message?: string;
}

export function pushBranch(opts: PushBranchOpts): PushBranchResult {
  assertNonEmpty(opts.remote, "remote");
  assertNonEmpty(opts.branch, "branch");

  // `--no-push` wins over everything (SPEC §8). Evaluate it first so the
  // branch is never pushed regardless of consent state.
  if (opts.noPush) {
    return { state: "skipped-no-push" };
  }
  if (!opts.granted) {
    return { state: "skipped-refused" };
  }

  // SPEC §8 safety: argv array only, no refspec rewrite, no force.
  const argv: readonly string[] = ["push", opts.remote, opts.branch];
  const res = spawnSync("git", argv as string[], {
    cwd: opts.repoPath,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  const status = res.status ?? 1;
  if (status !== 0) {
    const detail = (res.stderr ?? "").trim() || (res.stdout ?? "").trim();
    return {
      state: "failed",
      message:
        detail.length > 0
          ? detail
          : `git push exited ${String(status)} without output.`,
    };
  }
  return { state: "pushed" };
}

function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0) {
    throw new Error(`pushBranch: '${name}' must be non-empty.`);
  }
}
