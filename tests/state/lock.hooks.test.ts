// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  acquireLock,
  installReleaseHooks,
  releaseLock,
} from "../../src/state/lock.ts";

let tmp: string;
let lockPath: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-lock-hooks-"));
  mkdirSync(path.join(tmp, ".samo"), { recursive: true });
  lockPath = path.join(tmp, ".samo", ".lock");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("state/lock — installReleaseHooks (SPEC §8)", () => {
  test("returns a detach function; calling it removes listeners and releases", () => {
    const handle = acquireLock({
      lockPath,
      slug: "demo",
      now: Date.now(),
      maxWallClockMinutes: 240,
    });

    // Collected via a spy emitter so we never install real signal handlers
    // into the Bun test runner (which would leak across tests).
    const listeners = new Map<string, () => void>();
    const detach = installReleaseHooks(handle, {
      onSignal: (sig, cb) => {
        listeners.set(sig, cb);
      },
      onExit: (cb) => {
        listeners.set("exit", cb);
      },
    });

    expect(listeners.get("SIGINT")).toBeDefined();
    expect(listeners.get("SIGTERM")).toBeDefined();
    expect(listeners.get("exit")).toBeDefined();

    // Simulate an exit firing the hook.
    listeners.get("exit")?.();
    expect(existsSync(lockPath)).toBe(false);

    detach();
  });

  test("detach function unregisters the previously installed listeners", () => {
    const handle = acquireLock({
      lockPath,
      slug: "demo",
      now: Date.now(),
      maxWallClockMinutes: 240,
    });

    const removed: string[] = [];
    const detach = installReleaseHooks(handle, {
      onSignal: () => {
        /* no-op */
      },
      onExit: () => {
        /* no-op */
      },
      offSignal: (sig) => {
        removed.push(sig);
      },
      offExit: () => {
        removed.push("exit");
      },
    });

    detach();
    expect(removed.sort()).toEqual(["SIGINT", "SIGTERM", "exit"].sort());
    releaseLock(handle);
  });
});
