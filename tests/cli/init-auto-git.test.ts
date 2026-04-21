// Copyright 2026 Nikolay Samokhvalov.

/**
 * RED tests for #72 — auto-initialize git repo on first samospec invocation.
 *
 * Scenarios:
 *   1. No .git dir + --yes/non-interactive  → git init + empty commit + proceeds
 *   2. No .git dir + prompt "I"/Enter       → git init + empty commit + proceeds
 *   3. No .git dir + prompt "A"             → exits code 3, disk untouched
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runInit } from "../../src/cli/init.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-autogit-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function hasGit(dir: string): boolean {
  return existsSync(path.join(dir, ".git"));
}

function headCommit(dir: string): string | null {
  const res = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env },
  });
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

function logMessages(dir: string): string[] {
  const res = spawnSync("git", ["log", "--format=%s"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env },
  });
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe("samospec init — auto-initialize git repo (#72)", () => {
  test(
    "no .git + --yes: creates .git, empty initial commit, and proceeds (exit 0)",
    () => {
      // tmp has no .git directory at all.
      expect(hasGit(tmp)).toBe(false);

      const result = runInit({ cwd: tmp, yes: true });

      expect(result.exitCode).toBe(0);
      // .git should now exist.
      expect(hasGit(tmp)).toBe(true);
      // HEAD should be resolvable (empty commit was created).
      expect(headCommit(tmp)).not.toBeNull();
      // Commit message should be "chore: init".
      expect(logMessages(tmp)).toContain("chore: init");
      // Should mention creating git repo.
      expect(result.stdout.toLowerCase()).toMatch(
        /created git repo|initialized git|git init/,
      );
      // .samo/ should still be created.
      expect(existsSync(path.join(tmp, ".samo", "config.json"))).toBe(true);
    },
  );

  test(
    "no .git + interactive prompt 'I': creates .git, empty commit, proceeds (exit 0)",
    () => {
      expect(hasGit(tmp)).toBe(false);

      // Simulate interactive: user presses Enter (which defaults to init).
      const result = runInit({ cwd: tmp, gitInitAnswer: "I" });

      expect(result.exitCode).toBe(0);
      expect(hasGit(tmp)).toBe(true);
      expect(headCommit(tmp)).not.toBeNull();
      expect(logMessages(tmp)).toContain("chore: init");
    },
  );

  test(
    "no .git + interactive prompt Enter (default): creates .git and proceeds",
    () => {
      expect(hasGit(tmp)).toBe(false);

      // Empty string simulates pressing Enter (default = init).
      const result = runInit({ cwd: tmp, gitInitAnswer: "" });

      expect(result.exitCode).toBe(0);
      expect(hasGit(tmp)).toBe(true);
      expect(headCommit(tmp)).not.toBeNull();
    },
  );

  test(
    "no .git + interactive prompt 'A': exits code 3 without touching disk",
    () => {
      expect(hasGit(tmp)).toBe(false);

      const result = runInit({ cwd: tmp, gitInitAnswer: "A" });

      // Must exit 3 (user abort).
      expect(result.exitCode).toBe(3);
      // .git must NOT have been created.
      expect(hasGit(tmp)).toBe(false);
      // .samo/ must NOT have been created.
      expect(existsSync(path.join(tmp, ".samo"))).toBe(false);
      // stderr should mention abort.
      expect(result.stderr.toLowerCase()).toMatch(/abort|cancel/);
    },
  );

  test(
    "no .git + --yes: stdout confirms git repo creation",
    () => {
      const result = runInit({ cwd: tmp, yes: true });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(
        /created git repo and initial commit|git init/i,
      );
    },
  );
});
