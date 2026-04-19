// Copyright 2026 Nikolay Samokhvalov.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { lockSchema, type Lock } from "./types.ts";

// SPEC §8 — stale detection has two reasons.
export type LockStaleReason = "pid_dead" | "age_exceeded";

// Buffer added on top of `max_wall_clock_minutes` before a lock is
// declared stale purely by age (SPEC §8).
export const STALE_AGE_BUFFER_MINUTES = 30;

export class LockContendedError extends Error {
  public readonly holderPid: number;
  public readonly lockPath: string;
  constructor(lockPath: string, holderPid: number) {
    super(
      `another samospec process (pid ${holderPid}) holds the repo lock at ${lockPath}`,
    );
    this.name = "LockContendedError";
    this.holderPid = holderPid;
    this.lockPath = lockPath;
  }
}

export interface LockHandle {
  readonly lockPath: string;
  readonly pid: number;
  readonly slug: string;
}

export interface AcquireLockArgs {
  readonly lockPath: string;
  readonly slug: string;
  readonly now: number;
  readonly maxWallClockMinutes: number;
  // Optional injection seam: defaults to process.pid.
  readonly pid?: number;
  // Optional injection seam: defaults to a POSIX `kill(pid, 0)` probe.
  readonly isPidAlive?: (pid: number) => boolean;
}

export interface StaleLockInfo {
  readonly lock: Lock;
  readonly now: number;
  readonly maxWallClockMinutes: number;
  readonly isPidAlive?: (pid: number) => boolean;
}

/**
 * Default POSIX-style PID liveness probe. `process.kill(pid, 0)` does
 * not actually send a signal but raises ESRCH if the PID is no longer
 * running. Per SPEC §8, false negatives (dead PID misreported as alive)
 * are absorbed by the age_exceeded cross-check.
 */
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM = pid exists but we are not allowed to signal it — still alive.
    if (code === "EPERM") return true;
    return false;
  }
}

/**
 * Determine whether an existing lock should be considered stale per
 * SPEC §8. Returns the reason, or null when the lock is still live.
 */
export function isLockStale(info: StaleLockInfo): LockStaleReason | null {
  const probe = info.isPidAlive ?? defaultIsPidAlive;
  if (!probe(info.lock.pid)) {
    return "pid_dead";
  }
  const startedAtMs = Date.parse(info.lock.started_at);
  if (!Number.isFinite(startedAtMs)) {
    // Unparseable timestamp is conservatively treated as age-exceeded so
    // we do not block forever on a garbage lock (SPEC §8 stale removal).
    return "age_exceeded";
  }
  const ageMs = info.now - startedAtMs;
  const maxAgeMs =
    (info.maxWallClockMinutes + STALE_AGE_BUFFER_MINUTES) * 60_000;
  if (ageMs > maxAgeMs) return "age_exceeded";
  return null;
}

/**
 * Read a .lock file. Returns null if absent or malformed — malformed is
 * treated as "no valid owner" so acquireLock can overwrite it safely.
 */
export function readLock(file: string): Lock | null {
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = lockSchema.safeParse(parsed);
  if (!result.success) return null;
  return result.data;
}

/**
 * Acquire the repo-level lock. Raises LockContendedError if a live,
 * non-stale holder is present (exit 2 per SPEC §8). Stale or malformed
 * lock files are auto-removed and overwritten with ours.
 */
export function acquireLock(args: AcquireLockArgs): LockHandle {
  const pid = args.pid ?? process.pid;
  const probe = args.isPidAlive ?? defaultIsPidAlive;

  const existing = readLock(args.lockPath);
  if (existing !== null && existing.pid !== pid) {
    const staleReason = isLockStale({
      lock: existing,
      now: args.now,
      maxWallClockMinutes: args.maxWallClockMinutes,
      isPidAlive: probe,
    });
    if (staleReason === null) {
      throw new LockContendedError(args.lockPath, existing.pid);
    }
    // Stale — remove, log, fall through to acquire.
    try {
      unlinkSync(args.lockPath);
    } catch {
      /* best-effort */
    }
  } else if (existing === null && existsSync(args.lockPath)) {
    // Malformed lock file on disk; overwrite-as-stale.
    try {
      unlinkSync(args.lockPath);
    } catch {
      /* best-effort */
    }
  }

  const lock: Lock = {
    pid,
    started_at: new Date(args.now).toISOString(),
    slug: args.slug,
  };

  writeLockFile(args.lockPath, lock);

  return { lockPath: args.lockPath, pid, slug: args.slug };
}

/**
 * Release a lock acquired by this process. Safe to call twice or on a
 * file that has already been removed (idempotent cleanup).
 */
export function releaseLock(handle: LockHandle): void {
  try {
    const current = readLock(handle.lockPath);
    if (current === null || current.pid === handle.pid) {
      if (existsSync(handle.lockPath)) {
        unlinkSync(handle.lockPath);
      }
    }
  } catch {
    // Best-effort; exit-time cleanup must never throw.
  }
}

/**
 * Signals we release the lock on. SIGKILL is intentionally omitted —
 * it cannot be intercepted; the stale-lock path handles that case.
 */
export const RELEASE_SIGNALS = ["SIGINT", "SIGTERM"] as const;
export type ReleaseSignal = (typeof RELEASE_SIGNALS)[number];

type SignalRegister = (sig: ReleaseSignal, cb: () => void) => void;
type ExitRegister = (cb: () => void) => void;

export interface ReleaseHookEmitter {
  readonly onSignal: SignalRegister;
  readonly onExit: ExitRegister;
  readonly offSignal?: SignalRegister;
  readonly offExit?: ExitRegister;
}

const defaultEmitter: ReleaseHookEmitter = {
  onSignal: (sig, cb) => {
    process.on(sig, cb);
  },
  onExit: (cb) => {
    process.on("exit", cb);
  },
  offSignal: (sig, cb) => {
    process.off(sig, cb);
  },
  offExit: (cb) => {
    process.off("exit", cb);
  },
};

/**
 * Install SIGINT / SIGTERM / exit listeners that release `handle`. The
 * returned detach function removes them — call it in tests and on any
 * replace-handle path so listeners do not accumulate.
 *
 * Per SPEC §8 the lock must be released on "normal + SIGINT + SIGTERM"
 * exits. SIGKILL and power loss are absorbed by the stale-lock rule.
 */
export function installReleaseHooks(
  handle: LockHandle,
  emitter: ReleaseHookEmitter = defaultEmitter,
): () => void {
  const onExit = (): void => {
    releaseLock(handle);
  };
  const signalHandlers: Partial<Record<ReleaseSignal, () => void>> = {};
  for (const sig of RELEASE_SIGNALS) {
    const h = (): void => {
      releaseLock(handle);
    };
    signalHandlers[sig] = h;
    emitter.onSignal(sig, h);
  }
  emitter.onExit(onExit);

  return (): void => {
    for (const sig of RELEASE_SIGNALS) {
      const h = signalHandlers[sig];
      if (h !== undefined) emitter.offSignal?.(sig, h);
    }
    emitter.offExit?.(onExit);
  };
}

function writeLockFile(file: string, lock: Lock): void {
  const validated = lockSchema.parse(lock);
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp.${process.pid}`);
  const payload = `${JSON.stringify(validated, null, 2)}\n`;

  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, payload, 0, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
