// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { ensureHasCommit } from "../../src/git/ensure-has-commit.ts";

// Helper: init a bare git repo with NO commits.
function createEmptyRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "samospec-empty-repo-test-"));
  const run = (args: string[]) =>
    spawnSync("git", args, {
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

  run(["init", "--initial-branch", "main", dir]);
  run(["config", "user.name", "Samospec Test"]);
  run(["config", "user.email", "test@example.invalid"]);
  run(["config", "commit.gpgsign", "false"]);
  // Deliberately no commit — repo has no HEAD.
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("ensureHasCommit — empty repo (no HEAD)", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = createEmptyRepo());
  });
  afterEach(() => cleanup());

  test("returns { created: true } when repo has no commits", () => {
    const result = ensureHasCommit({ repoPath: dir });
    expect(result.created).toBe(true);
  });

  test("creates a commit so HEAD is now resolvable", () => {
    ensureHasCommit({ repoPath: dir });
    const rev = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(rev.status).toBe(0);
    expect(rev.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  test("commit message is the standard samospec message", () => {
    ensureHasCommit({ repoPath: dir });
    const log = spawnSync("git", ["log", "--format=%s", "-1"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(log.stdout.trim()).toBe(
      "chore: initial commit (created by samospec)",
    );
  });
});

describe("ensureHasCommit — repo already has commits", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    // Use createEmptyRepo then add a commit manually.
    ({ dir, cleanup } = createEmptyRepo());
    const run = (args: string[]) =>
      spawnSync("git", args, {
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
    run(["commit", "--allow-empty", "-m", "chore: existing commit"]);
  });
  afterEach(() => cleanup());

  test("returns { created: false } when repo already has commits", () => {
    const result = ensureHasCommit({ repoPath: dir });
    expect(result.created).toBe(false);
  });

  test("does not add a new commit when HEAD already exists", () => {
    const before = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim();
    ensureHasCommit({ repoPath: dir });
    const after = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim();
    expect(after).toBe(before);
  });
});
