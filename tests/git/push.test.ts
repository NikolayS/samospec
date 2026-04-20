// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §8 — `pushBranch` contract.
 *
 * - Pushes `git push <remote> <branch>` (never `--force`, `--force-with-lease`,
 *   `+refs/`, `--no-verify`).
 * - Honors `noPush: true` → no push attempt, result state `skipped-no-push`.
 * - Honors consent `refuse` → no push attempt, result state `skipped-refused`.
 * - Ungated consent accept → pushes and reports `pushed`.
 * - Uses argv arrays only (no shell concat).
 * - Integration test: drives a real temp bare remote; confirms the ref
 *   lands on the remote after push.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { pushBranch } from "../../src/git/push.ts";
import { createTempRepo } from "./helpers/tempRepo.ts";

function makeBareRemote(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "samospec-bare-remote-"));
  const res = spawnSync("git", ["init", "--bare", "--initial-branch", "main"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`bare init failed: ${res.stderr}`);
  }
  return dir;
}

function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe("pushBranch — real bare remote integration", () => {
  test("granted consent: pushes the branch and ref lands on the remote", () => {
    const repo = createTempRepo();
    const bare = makeBareRemote();
    try {
      // Wire origin → bare remote.
      repo.run(["remote", "add", "origin", bare]);
      repo.run(["checkout", "-b", "samospec/refunds"]);
      writeFileSync(path.join(repo.dir, "touch.txt"), "x\n");
      repo.run(["add", "touch.txt"]);
      repo.run(["commit", "-m", "spec(refunds): draft v0.1"]);

      const result = pushBranch({
        repoPath: repo.dir,
        remote: "origin",
        branch: "samospec/refunds",
        granted: true,
        noPush: false,
      });
      expect(result.state).toBe("pushed");

      const ls = spawnSync(
        "git",
        ["--git-dir", bare, "show-ref", "--verify", "refs/heads/samospec/refunds"],
        { encoding: "utf8" },
      );
      expect(ls.status).toBe(0);
      expect(ls.stdout).toContain("refs/heads/samospec/refunds");
    } finally {
      repo.cleanup();
      cleanupDir(bare);
    }
  });

  test("noPush=true skips even with granted consent; ref never hits remote", () => {
    const repo = createTempRepo();
    const bare = makeBareRemote();
    try {
      repo.run(["remote", "add", "origin", bare]);
      repo.run(["checkout", "-b", "samospec/refunds"]);
      writeFileSync(path.join(repo.dir, "touch.txt"), "x\n");
      repo.run(["add", "touch.txt"]);
      repo.run(["commit", "-m", "spec(refunds): draft v0.1"]);

      const result = pushBranch({
        repoPath: repo.dir,
        remote: "origin",
        branch: "samospec/refunds",
        granted: true,
        noPush: true,
      });
      expect(result.state).toBe("skipped-no-push");

      const ls = spawnSync(
        "git",
        ["--git-dir", bare, "show-ref", "refs/heads/samospec/refunds"],
        { encoding: "utf8", cwd: bare },
      );
      expect(ls.status).not.toBe(0);
    } finally {
      repo.cleanup();
      cleanupDir(bare);
    }
  });

  test("granted=false (consent refused): no push attempt", () => {
    const repo = createTempRepo();
    const bare = makeBareRemote();
    try {
      repo.run(["remote", "add", "origin", bare]);
      repo.run(["checkout", "-b", "samospec/refunds"]);
      writeFileSync(path.join(repo.dir, "touch.txt"), "x\n");
      repo.run(["add", "touch.txt"]);
      repo.run(["commit", "-m", "spec(refunds): draft v0.1"]);

      const result = pushBranch({
        repoPath: repo.dir,
        remote: "origin",
        branch: "samospec/refunds",
        granted: false,
        noPush: false,
      });
      expect(result.state).toBe("skipped-refused");

      const ls = spawnSync(
        "git",
        ["--git-dir", bare, "show-ref", "refs/heads/samospec/refunds"],
        { encoding: "utf8", cwd: bare },
      );
      expect(ls.status).not.toBe(0);
    } finally {
      repo.cleanup();
      cleanupDir(bare);
    }
  });

  test("push failure returns { state: 'failed' } with captured stderr (no throw)", () => {
    const repo = createTempRepo();
    try {
      // Configure a bogus remote URL so push fails.
      repo.run([
        "remote",
        "add",
        "origin",
        path.join(repo.dir, "does-not-exist.git"),
      ]);
      repo.run(["checkout", "-b", "samospec/x"]);
      writeFileSync(path.join(repo.dir, "touch.txt"), "x\n");
      repo.run(["add", "touch.txt"]);
      repo.run(["commit", "-m", "spec(x): draft v0.1"]);

      const result = pushBranch({
        repoPath: repo.dir,
        remote: "origin",
        branch: "samospec/x",
        granted: true,
        noPush: false,
      });
      expect(result.state).toBe("failed");
      expect(result.message?.length ?? 0).toBeGreaterThan(0);
    } finally {
      repo.cleanup();
    }
  });
});
