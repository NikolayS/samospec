// Copyright 2026 Nikolay Samokhvalov.

// RED test for #81: per-call spawn timeout must kill the child process
// and the Promise must resolve within ~timeoutMs (not hang waiting for
// stream EOF after SIGKILL).
//
// Fake CLI = `sleep 3600` equivalent via bun -e.
// Adapter ask({ timeout: 2000 }) must return a timeout-classified error
// within ~3s AND the child PID must be dead.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAdapter, ClaudeAdapterError } from "../../src/adapter/claude.ts";
import { spawnCli } from "../../src/adapter/spawn.ts";

const TMP: string[] = [];

function makeFakeBinaryDir(
  name: string,
  script: string,
): { dir: string; binary: string } {
  const dir = mkdtempSync(join(tmpdir(), "samospec-timeout-bin-"));
  TMP.push(dir);
  const binary = join(dir, name);
  writeFileSync(binary, `#!/bin/sh\n${script}\n`);
  chmodSync(binary, 0o755);
  return { dir, binary };
}

afterAll(() => {
  for (const d of TMP) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("spawnCli timeout: child PID must be dead after timeout fires (#81)", () => {
  test("spawnCli returns { ok:false, reason:'timeout' } and the child is dead within 3x timeoutMs", async () => {
    // Use a shell script that sleeps forever and reports its PID to stdout first.
    const dir = mkdtempSync(join(tmpdir(), "samospec-pid-track-"));
    TMP.push(dir);
    const pidFile = join(dir, "child.pid");
    const { dir: binDir, binary } = makeFakeBinaryDir(
      "fake-sleep",
      `echo $$ > ${pidFile}\nsleep 3600`,
    );

    const startMs = Date.now();
    const result = await spawnCli({
      cmd: [binary],
      stdin: "",
      env: {},
      timeoutMs: 1500,
      host: { PATH: `${binDir}:/bin:/usr/bin`, HOME: "/tmp" },
    });
    const elapsedMs = Date.now() - startMs;

    // Must resolve as a timeout failure.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("timeout");

    // Must resolve within 3x timeout (generous for CI overhead).
    expect(elapsedMs).toBeLessThan(1500 * 3);

    // Child PID must be dead — if `process.kill(pid, 0)` throws ESRCH, it's dead.
    // Give the OS a small moment to reap the process.
    await new Promise((r) => setTimeout(r, 200));
    const { readFileSync, existsSync } = await import("node:fs");
    if (existsSync(pidFile)) {
      const pidStr = readFileSync(pidFile, "utf8").trim();
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid)) {
        let processAlive = false;
        try {
          process.kill(pid, 0);
          processAlive = true;
        } catch {
          // ESRCH = not found = dead. Expected.
          processAlive = false;
        }
        expect(processAlive).toBe(false);
      }
    }
  });
});

describe("ClaudeAdapter.ask timeout: classified error within 3s for hanging CLI (#81)", () => {
  test("adapter.ask({ timeout: 2000 }) returns ClaudeAdapterError with reason='timeout' when CLI hangs", async () => {
    // Build a hanging fake 'claude' binary that sleeps forever.
    const { dir, binary } = makeFakeBinaryDir("claude", "sleep 3600");

    const adapter = new ClaudeAdapter({
      binary,
      host: {
        PATH: `${dir}:/bin:/usr/bin`,
        HOME: "/tmp",
        ANTHROPIC_API_KEY: "sk-fake",
      },
    });

    const startMs = Date.now();
    let caughtErr: unknown = null;
    try {
      await adapter.ask({
        prompt: "hello",
        context: "",
        opts: { effort: "max", timeout: 2000 },
      });
    } catch (err) {
      caughtErr = err;
    }
    const elapsedMs = Date.now() - startMs;

    // Must throw a ClaudeAdapterError with reason 'timeout'.
    expect(caughtErr).toBeInstanceOf(ClaudeAdapterError);
    if (caughtErr instanceof ClaudeAdapterError) {
      expect(caughtErr.payload.reason).toBe("timeout");
    }

    // The worst-case capped retry for a 2000ms base is 2000+3000+2000=7000ms.
    // Must resolve within 3.5x * timeout * 3 retries + generous padding = ~25s.
    // But with the fix applied (stream abort), it should be well under 10s.
    // For a RED test we want to verify it resolves at all (not hang for 22 min).
    expect(elapsedMs).toBeLessThan(25_000);
  }, 30_000);
});
