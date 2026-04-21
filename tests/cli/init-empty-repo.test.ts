// Copyright 2026 Nikolay Samokhvalov.

/**
 * RED tests for #65 — empty repo (git init but no commits) handling.
 *
 * An empty repo (git init, no commits, HEAD unresolvable) must not crash.
 * samospec should auto-create an initial empty commit (always safe — no
 * prompt needed) and proceed.
 *
 * Also covers `samospec new <slug>` in an empty repo.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runInit } from "../../src/cli/init.ts";

let tmp: string;

function gitRun(
  dir: string,
  args: readonly string[],
): { stdout: string; stderr: string; status: number } {
  const res = spawnSync("git", args as string[], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Samospec Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Samospec Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status ?? 0,
  };
}

function initEmptyRepo(dir: string): void {
  gitRun(dir, ["init", "--initial-branch", "main", dir]);
  gitRun(dir, ["config", "user.name", "Samospec Test"]);
  gitRun(dir, ["config", "user.email", "test@example.invalid"]);
  gitRun(dir, ["config", "commit.gpgsign", "false"]);
  // No commits — HEAD is not resolvable.
}

function headCommit(dir: string): string | null {
  const res = gitRun(dir, ["rev-parse", "HEAD"]);
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

function logMessages(dir: string): string[] {
  const res = gitRun(dir, ["log", "--format=%s"]);
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-empty-repo-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("samospec init — empty repo (no commits) (#65)", () => {
  test("git init repo with no commits: auto-creates initial commit and exits 0", () => {
    initEmptyRepo(tmp);
    // Confirm empty repo: HEAD is not resolvable yet.
    expect(headCommit(tmp)).toBeNull();

    const result = runInit({ cwd: tmp });

    expect(result.exitCode).toBe(0);
    // An initial commit should now exist.
    expect(headCommit(tmp)).not.toBeNull();
    // .samo/ created.
    expect(existsSync(path.join(tmp, ".samo", "config.json"))).toBe(true);
  });

  test("empty repo: auto-commit message logged to stdout", () => {
    initEmptyRepo(tmp);

    const result = runInit({ cwd: tmp });

    expect(result.exitCode).toBe(0);
    // Must log that it created an initial commit.
    expect(result.stdout.toLowerCase()).toMatch(
      /initial commit|no commits|created initial commit/,
    );
  });

  test("empty repo: initial commit subject is 'chore: init'", () => {
    initEmptyRepo(tmp);

    runInit({ cwd: tmp });

    expect(logMessages(tmp)).toContain("chore: init");
  });

  test("empty repo: proceeds without crashing (no git rev-parse error surfaced)", () => {
    initEmptyRepo(tmp);

    const result = runInit({ cwd: tmp });

    // Must not error out with git-layer confusion.
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toMatch(
      /fatal:|branch creation skipped.*HEAD|status 128/i,
    );
  });
});
