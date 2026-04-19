// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  LockContendedError,
  LockStaleReason,
  StaleLockInfo,
  acquireLock,
  isLockStale,
  readLock,
  releaseLock,
} from "../../src/state/lock.ts";

const MINUTE = 60_000;

let tmp: string;
let lockPath: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-lock-"));
  mkdirSync(path.join(tmp, ".samospec"), { recursive: true });
  lockPath = path.join(tmp, ".samospec", ".lock");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function aliveButNotUs(): number {
  // PID 1 is guaranteed alive on POSIX and not us; used to simulate a
  // live concurrent owner without actually spawning a second process.
  return 1;
}

describe("state/lock — acquire + release", () => {
  test("acquireLock creates the lock file with pid + slug + started_at", () => {
    const handle = acquireLock({
      lockPath,
      slug: "demo",
      now: Date.now(),
      maxWallClockMinutes: 240,
    });
    expect(existsSync(lockPath)).toBe(true);
    const onDisk = readLock(lockPath);
    expect(onDisk?.pid).toBe(handle.pid);
    expect(onDisk?.slug).toBe("demo");
    releaseLock(handle);
  });

  test("releaseLock removes the lock file", () => {
    const handle = acquireLock({
      lockPath,
      slug: "demo",
      now: Date.now(),
      maxWallClockMinutes: 240,
    });
    releaseLock(handle);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("releaseLock is idempotent on an already-gone file", () => {
    const handle = acquireLock({
      lockPath,
      slug: "demo",
      now: Date.now(),
      maxWallClockMinutes: 240,
    });
    releaseLock(handle);
    releaseLock(handle); // must not throw
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a second acquire while held throws LockContendedError with PID message", () => {
    const first = acquireLock({
      lockPath,
      slug: "demo",
      now: Date.now(),
      maxWallClockMinutes: 240,
    });
    expect(() =>
      acquireLock({
        lockPath,
        slug: "demo",
        now: Date.now(),
        maxWallClockMinutes: 240,
      }),
    ).toThrow(LockContendedError);
    try {
      acquireLock({
        lockPath,
        slug: "demo",
        now: Date.now(),
        maxWallClockMinutes: 240,
      });
    } catch (err) {
      expect((err as Error).message).toContain(String(first.pid));
    }
    releaseLock(first);
  });
});

describe("state/lock — stale detection (SPEC §8)", () => {
  test("isLockStale returns null for a fresh live-PID lock", () => {
    const now = Date.now();
    const info: StaleLockInfo = {
      lock: {
        pid: process.pid, // alive, and known-fresh
        slug: "demo",
        started_at: new Date(now - MINUTE).toISOString(),
      },
      now,
      maxWallClockMinutes: 240,
    };
    expect(isLockStale(info)).toBeNull();
  });

  test("isLockStale reports pid_dead when the PID is gone", () => {
    const now = Date.now();
    const info: StaleLockInfo = {
      lock: {
        // Very large PID unlikely to exist.
        pid: 99999999,
        slug: "demo",
        started_at: new Date(now - MINUTE).toISOString(),
      },
      now,
      maxWallClockMinutes: 240,
    };
    expect(isLockStale(info)).toBe<LockStaleReason>("pid_dead");
  });

  test("isLockStale reports age_exceeded past max_wall_clock + 30min buffer", () => {
    const now = Date.now();
    const info: StaleLockInfo = {
      lock: {
        // Use our own PID so the pid_dead path does not short-circuit;
        // ensure age is older than 240 + 30 minutes.
        pid: process.pid,
        slug: "demo",
        started_at: new Date(now - (240 + 31) * MINUTE).toISOString(),
      },
      now,
      maxWallClockMinutes: 240,
    };
    expect(isLockStale(info)).toBe<LockStaleReason>("age_exceeded");
  });

  test("isLockStale honours a custom maxWallClockMinutes", () => {
    const now = Date.now();
    const info: StaleLockInfo = {
      lock: {
        pid: process.pid,
        slug: "demo",
        started_at: new Date(now - 40 * MINUTE).toISOString(),
      },
      now,
      maxWallClockMinutes: 5, // 5 + 30 = 35 buffer, age 40 is stale
    };
    expect(isLockStale(info)).toBe<LockStaleReason>("age_exceeded");
  });
});

describe("state/lock — acquire against stale file", () => {
  test("acquireLock auto-removes a stale lock and succeeds", () => {
    const now = Date.now();
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 99999999,
        slug: "demo",
        started_at: new Date(now - MINUTE).toISOString(),
      }),
      "utf8",
    );
    const handle = acquireLock({
      lockPath,
      slug: "demo",
      now,
      maxWallClockMinutes: 240,
    });
    expect(handle.pid).toBe(process.pid);
    releaseLock(handle);
  });

  test("acquireLock refuses when holder is alive and lock is fresh", () => {
    const now = Date.now();
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: aliveButNotUs(),
        slug: "demo",
        started_at: new Date(now - MINUTE).toISOString(),
      }),
      "utf8",
    );
    expect(() =>
      acquireLock({
        lockPath,
        slug: "demo",
        now,
        maxWallClockMinutes: 240,
      }),
    ).toThrow(LockContendedError);
  });

  test("acquireLock auto-removes an age-exceeded lock even if PID is alive", () => {
    const now = Date.now();
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: aliveButNotUs(),
        slug: "demo",
        started_at: new Date(now - (240 + 31) * MINUTE).toISOString(),
      }),
      "utf8",
    );
    const handle = acquireLock({
      lockPath,
      slug: "demo",
      now,
      maxWallClockMinutes: 240,
    });
    expect(handle.pid).toBe(process.pid);
    releaseLock(handle);
  });

  test("acquireLock overwrites a malformed lock file as if stale", () => {
    writeFileSync(lockPath, "not json at all", "utf8");
    const handle = acquireLock({
      lockPath,
      slug: "demo",
      now: Date.now(),
      maxWallClockMinutes: 240,
    });
    expect(handle.pid).toBe(process.pid);
    releaseLock(handle);
  });
});
