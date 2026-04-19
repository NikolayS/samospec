// Copyright 2026 Nikolay Samokhvalov.

import { existsSync } from "node:fs";

import { defaultIsPidAlive, isLockStale, readLock } from "../../state/lock.ts";
import { CheckStatus, type CheckResult } from "../doctor-format.ts";

export interface CheckLockfileArgs {
  readonly lockPath: string;
  readonly now: number;
  readonly maxWallClockMinutes: number;
  readonly isPidAlive?: (pid: number) => boolean;
}

/**
 * Reports on `.samospec/.lock`. Uses the Issue #2 helpers in
 * `src/state/lock.ts` — does NOT reimplement stale detection.
 *
 *   - OK   — no lock file on disk.
 *   - WARN — a live lock file is present (another samospec process owns
 *            it; SPEC §8 will surface this as "exit 2: lock contention"
 *            if the user tries to run samospec concurrently).
 *   - FAIL — a stale lock is present (pid dead or age exceeded); user
 *            intervention recommended.
 */
export function checkLockfile(args: CheckLockfileArgs): CheckResult {
  const probe = args.isPidAlive ?? defaultIsPidAlive;

  if (!existsSync(args.lockPath)) {
    return {
      status: CheckStatus.Ok,
      label: "lockfile",
      message: "no .samospec/.lock present",
    };
  }

  const lock = readLock(args.lockPath);
  if (lock === null) {
    return {
      status: CheckStatus.Fail,
      label: "lockfile",
      message: `lockfile at ${args.lockPath} is unreadable or malformed — stale`,
    };
  }

  const staleReason = isLockStale({
    lock,
    now: args.now,
    maxWallClockMinutes: args.maxWallClockMinutes,
    isPidAlive: probe,
  });

  if (staleReason === null) {
    return {
      status: CheckStatus.Warn,
      label: "lockfile",
      message:
        `a live samospec run is holding the lock ` +
        `(pid ${lock.pid}, slug '${lock.slug}', ` +
        `started ${lock.started_at})`,
    };
  }

  return {
    status: CheckStatus.Fail,
    label: "lockfile",
    message:
      `stale lock (${staleReason}); pid ${lock.pid}, ` +
      `started ${lock.started_at}. Remove ${args.lockPath} to continue.`,
  };
}
