// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §8 — Remote reconciliation + offline resume (Sprint 3 #3).
 *
 * Contract:
 *   - FF success           → { state: "fast-forwarded", exitCode: 0 }
 *     (or `up-to-date` when remote/local already match)
 *   - Non-FF divergence    → { state: "diverged",       exitCode: 2,
 *                              message: human-readable guidance }
 *   - Fetch timeout / fail → { state: "remote-stale",   exitCode: 0 }
 *     Caller is responsible for flipping
 *     `state.json.remote_stale = true` so the next online resume
 *     reconciles first.
 *
 * Never force-pushes, never auto-rebases, never rewrites history. Fetch
 * only — push is consent-gated and handled elsewhere (Sprint 3 #4).
 *
 * `verifyHeadSha` supports the `state.json` HEAD-mismatch check: if the
 * recorded sha differs from the local branch HEAD and we can't
 * fast-forward to match, callers translate the thrown error into exit 2.
 */

import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";

export type ReconcileState =
  | "up-to-date"
  | "fast-forwarded"
  | "remote-stale"
  | "diverged";

export interface ReconcileOutcome {
  readonly state: ReconcileState;
  readonly exitCode: number;
  readonly message?: string;
}

export interface ReconcileRemoteOpts {
  readonly repoPath: string;
  readonly branch: string;
  readonly remote: string;
  /**
   * SPEC §8 — `git.fetch_timeout_seconds`, default 5s. Passed to
   * `timeout(1)` when available, otherwise a Node-side kill timer fires.
   */
  readonly timeoutSeconds: number;
}

export function reconcileRemote(opts: ReconcileRemoteOpts): ReconcileOutcome {
  assertNonEmpty(opts.branch, "branch");
  assertNonEmpty(opts.remote, "remote");
  if (!Number.isFinite(opts.timeoutSeconds) || opts.timeoutSeconds <= 0) {
    throw new Error(
      `reconcileRemote: timeoutSeconds must be > 0 (got ${String(
        opts.timeoutSeconds,
      )}).`,
    );
  }

  const fetch = runGitWithTimeout(
    ["fetch", "--no-tags", "--prune", opts.remote, opts.branch],
    opts.repoPath,
    opts.timeoutSeconds,
  );

  if (fetch.timedOut || fetch.status !== 0) {
    // Graceful degradation — caller continues local-only.
    return { state: "remote-stale", exitCode: 0 };
  }

  const localSha = resolveRef(opts.repoPath, "HEAD");
  const remoteRef = `refs/remotes/${opts.remote}/${opts.branch}`;
  const remoteSha = resolveRef(opts.repoPath, remoteRef);

  if (localSha === null || remoteSha === null) {
    // Fetch succeeded but we can't resolve one side — treat as
    // remote-stale so the run continues; the caller logs and retries.
    return { state: "remote-stale", exitCode: 0 };
  }

  if (localSha === remoteSha) {
    return { state: "up-to-date", exitCode: 0 };
  }

  // FF iff local is an ancestor of remote. If local is NOT an ancestor,
  // histories diverged.
  const isAncestor = runGit(
    ["merge-base", "--is-ancestor", localSha, remoteSha],
    opts.repoPath,
    { allowFail: true },
  );
  if (isAncestor.status === 0) {
    // FF: merge --ff-only into the current branch. Never `--force`.
    const ff = runGit(["merge", "--ff-only", remoteSha], opts.repoPath, {
      allowFail: true,
    });
    if (ff.status !== 0) {
      return {
        state: "diverged",
        exitCode: 2,
        message:
          `Fast-forward into ${opts.branch} failed: ${ff.stderr.trim()}. ` +
          `Resolve manually; samospec will not auto-rebase.`,
      };
    }
    return { state: "fast-forwarded", exitCode: 0 };
  }

  // Not an ancestor — could be remote-is-ancestor (local ahead) or
  // true divergence. Either way, we don't force or rebase.
  const remoteIsAncestor = runGit(
    ["merge-base", "--is-ancestor", remoteSha, localSha],
    opts.repoPath,
    { allowFail: true },
  );
  if (remoteIsAncestor.status === 0) {
    // Local is ahead; a later push (consent-gated, elsewhere) will
    // publish. From reconciliation's perspective, up-to-date.
    return { state: "up-to-date", exitCode: 0 };
  }

  return {
    state: "diverged",
    exitCode: 2,
    message:
      `Local ${opts.branch} and ${opts.remote}/${opts.branch} have ` +
      `diverged. samospec will not auto-rebase or force. Resolve the ` +
      `conflict manually (git pull --rebase after review, or merge), ` +
      `then rerun samospec resume.`,
  };
}

export interface VerifyHeadShaOpts {
  readonly repoPath: string;
  readonly branch: string;
  /** If `null`, the check is a permissive no-op (first run). */
  readonly expectedHeadSha: string | null;
}

export class HeadShaMismatchError extends Error {
  public readonly exitCode = 2;
  public readonly expected: string;
  public readonly actual: string;
  public readonly branch: string;

  public constructor(branch: string, expected: string, actual: string) {
    super(
      `state.json.head_sha (${expected}) does not match local branch ` +
        `'${branch}' HEAD (${actual}). Refusing to proceed. Resolve the ` +
        `drift manually; samospec will not auto-rebase.`,
    );
    this.name = "HeadShaMismatchError";
    this.branch = branch;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Verify that `state.json.head_sha` still matches the local branch HEAD.
 * Throws {@link HeadShaMismatchError} (exit 2) on drift so the caller
 * can halt with an explanation per SPEC §8.
 */
export function verifyHeadSha(opts: VerifyHeadShaOpts): void {
  if (opts.expectedHeadSha === null) return;
  assertNonEmpty(opts.branch, "branch");
  const actual = resolveRef(opts.repoPath, "HEAD");
  if (actual === null) {
    throw new Error(
      `verifyHeadSha: local branch '${opts.branch}' has no HEAD (repo unborn?)`,
    );
  }
  if (actual !== opts.expectedHeadSha) {
    throw new HeadShaMismatchError(opts.branch, opts.expectedHeadSha, actual);
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0) {
    throw new Error(`reconcileRemote: '${name}' must be non-empty.`);
  }
}

function resolveRef(repoPath: string, ref: string): string | null {
  const res = runGit(["rev-parse", "--verify", "--quiet", ref], repoPath, {
    allowFail: true,
  });
  if (res.status !== 0) return null;
  const sha = res.stdout.trim();
  return sha.length > 0 ? sha : null;
}

interface RunGitResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runGit(
  args: readonly string[],
  cwd: string,
  opts: { readonly allowFail?: boolean } = {},
): RunGitResult {
  const result = spawnSync("git", args as string[], { cwd, encoding: "utf8" });
  const status = result.status ?? 1;
  if (status !== 0 && !opts.allowFail) {
    throw new Error(
      `git ${args.join(" ")} failed with status ${String(status)}: ${
        result.stderr ?? ""
      }`,
    );
  }
  return {
    status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

interface RunGitWithTimeoutResult extends RunGitResult {
  readonly timedOut: boolean;
}

/**
 * Run `git <args>` with a wall-clock timeout. Bun's `spawnSync`
 * supports `timeout` since 1.x, so we pass it through. On timeout the
 * result has `status === null` and we translate to `timedOut: true`.
 */
function runGitWithTimeout(
  args: readonly string[],
  cwd: string,
  timeoutSeconds: number,
): RunGitWithTimeoutResult {
  const options: SpawnSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf8",
    timeout: Math.ceil(timeoutSeconds * 1000),
    // Minimal env — we deliberately refuse to prompt for credentials
    // from the terminal during reconciliation; the offline path will
    // handle that by returning `remote-stale`.
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  };
  const result = spawnSync("git", args as string[], options);
  const rawStatus = result.status;
  const timedOut = rawStatus === null;
  return {
    status: rawStatus ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut,
  };
}
