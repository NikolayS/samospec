// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §8 — Remote reconciliation + offline resume (Sprint 3 #3).
 *
 * - FF success → `fast-forwarded` (or `up-to-date` if the fetch was a no-op).
 * - Non-FF divergence → halt (exit 2), clear message, NOT auto-rebase, NOT
 *   force. Outcome `diverged`.
 * - Fetch timeout / failure → continue local-only, outcome `remote-stale`.
 *   Caller sets `state.json.remote_stale = true`.
 * - Next online resume clears `remote_stale` after successful reconciliation.
 * - `state.json.head_sha` vs. local branch HEAD mismatch → halt with exit 2.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  HeadShaMismatchError,
  reconcileRemote,
  verifyHeadSha,
  type ReconcileOutcome,
} from "../../src/git/remote.ts";
import { createTempRepo, type TempRepo } from "./helpers/tempRepo.ts";

function createBareRemote(): string {
  const dir = mkdtempSync(join(tmpdir(), "samospec-remote-"));
  const bare = join(dir, "remote.git");
  const result = spawnSync("git", ["init", "--bare", bare], {
    encoding: "utf8",
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `git init --bare failed: ${result.stderr ?? String(result.status)}`,
    );
  }
  return bare;
}

function runGit(args: readonly string[], cwd: string): string {
  const res = spawnSync("git", args as string[], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Samospec Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Samospec Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  if ((res.status ?? 1) !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${res.stderr ?? ""} (${String(res.status)})`,
    );
  }
  return res.stdout ?? "";
}

describe("reconcileRemote — happy path (FF / up-to-date)", () => {
  let bare: string;
  let local: TempRepo;
  const branch = "samospec/refunds";

  beforeEach(() => {
    bare = createBareRemote();
    local = createTempRepo({ initialBranch: branch });
    runGit(["remote", "add", "origin", bare], local.dir);
    runGit(["push", "-u", "origin", branch], local.dir);
  });
  afterEach(() => {
    local.cleanup();
    rmSync(bare, { recursive: true, force: true });
  });

  test("returns 'up-to-date' when local and remote match", () => {
    const outcome: ReconcileOutcome = reconcileRemote({
      repoPath: local.dir,
      branch,
      remote: "origin",
      timeoutSeconds: 5,
    });
    expect(outcome.state).toBe("up-to-date");
  });

  test("fast-forwards when remote is ahead of local", () => {
    // Clone the remote into a second working tree, add a commit, push.
    const scratch = mkdtempSync(join(tmpdir(), "samospec-scratch-"));
    runGit(["clone", bare, "clone"], scratch);
    const clonedir = join(scratch, "clone");
    runGit(["config", "user.name", "Samospec Test"], clonedir);
    runGit(["config", "user.email", "test@example.invalid"], clonedir);
    runGit(["checkout", branch], clonedir);
    writeFileSync(join(clonedir, "from-remote.txt"), "added remotely\n");
    runGit(["add", "from-remote.txt"], clonedir);
    runGit(["commit", "-m", "add from-remote"], clonedir);
    runGit(["push", "origin", branch], clonedir);

    try {
      const outcome = reconcileRemote({
        repoPath: local.dir,
        branch,
        remote: "origin",
        timeoutSeconds: 5,
      });
      expect(outcome.state).toBe("fast-forwarded");
      // File from the remote is now present locally.
      const res = spawnSync("ls", [local.dir], { encoding: "utf8" });
      expect(res.stdout).toContain("from-remote.txt");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("reconcileRemote — non-FF divergence halts with exit 2", () => {
  let bare: string;
  let local: TempRepo;
  const branch = "samospec/refunds";

  beforeEach(() => {
    bare = createBareRemote();
    local = createTempRepo({ initialBranch: branch });
    runGit(["remote", "add", "origin", bare], local.dir);
    runGit(["push", "-u", "origin", branch], local.dir);
  });
  afterEach(() => {
    local.cleanup();
    rmSync(bare, { recursive: true, force: true });
  });

  test("diverged histories return 'diverged' without auto-rebase or force", () => {
    // Remote advances one way; local advances another — both have new commits
    // from a common ancestor, so they diverge (no FF possible).
    const scratch = mkdtempSync(join(tmpdir(), "samospec-scratch-"));
    runGit(["clone", bare, "clone"], scratch);
    const clonedir = join(scratch, "clone");
    runGit(["config", "user.name", "Samospec Test"], clonedir);
    runGit(["config", "user.email", "test@example.invalid"], clonedir);
    runGit(["checkout", branch], clonedir);
    writeFileSync(join(clonedir, "remote-change.txt"), "remote\n");
    runGit(["add", "remote-change.txt"], clonedir);
    runGit(["commit", "-m", "remote diverge"], clonedir);
    runGit(["push", "origin", branch], clonedir);

    // Local now adds its own commit — no FF possible.
    local.write("local-change.txt", "local\n");
    runGit(["add", "local-change.txt"], local.dir);
    runGit(["commit", "-m", "local diverge"], local.dir);

    try {
      const outcome = reconcileRemote({
        repoPath: local.dir,
        branch,
        remote: "origin",
        timeoutSeconds: 5,
      });
      expect(outcome.state).toBe("diverged");
      // Error-style payload; caller should surface and exit 2.
      expect(outcome.exitCode).toBe(2);
      expect(outcome.message).toBeDefined();
      expect(outcome.message?.length).toBeGreaterThan(0);

      // Local HEAD is unchanged — no auto-rebase, no force-apply.
      const before = runGit(["rev-parse", "HEAD"], local.dir).trim();
      expect(before).not.toBe("");
      const res = spawnSync("git", ["log", "--oneline", "-1"], {
        cwd: local.dir,
        encoding: "utf8",
      });
      expect(res.stdout).toContain("local diverge");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("reconcileRemote — offline / unreachable remote → remote-stale", () => {
  let local: TempRepo;
  const branch = "samospec/refunds";

  beforeEach(() => {
    local = createTempRepo({ initialBranch: branch });
    // Point at a non-routable URL. file:// to a non-existent bare path
    // fails instantly with a clean "not a repo" error.
    const fake = join(tmpdir(), "samospec-absent-remote.git");
    runGit(["remote", "add", "origin", `file://${fake}`], local.dir);
  });
  afterEach(() => {
    local.cleanup();
  });

  test("unreachable remote returns 'remote-stale' with exitCode 0", () => {
    const outcome = reconcileRemote({
      repoPath: local.dir,
      branch,
      remote: "origin",
      timeoutSeconds: 2,
    });
    expect(outcome.state).toBe("remote-stale");
    // Graceful degradation — caller continues local-only, no halt.
    expect(outcome.exitCode).toBe(0);
  });
});

describe("verifyHeadSha — state.json HEAD mismatch", () => {
  let local: TempRepo;
  const branch = "samospec/refunds";

  beforeEach(() => {
    local = createTempRepo({ initialBranch: branch });
  });
  afterEach(() => {
    local.cleanup();
  });

  test("matches when state.json.head_sha equals the branch HEAD", () => {
    const head = runGit(["rev-parse", "HEAD"], local.dir).trim();
    expect(() =>
      verifyHeadSha({ repoPath: local.dir, branch, expectedHeadSha: head }),
    ).not.toThrow();
  });

  test("throws HeadShaMismatchError (exit 2) on mismatch", () => {
    expect(() =>
      verifyHeadSha({
        repoPath: local.dir,
        branch,
        expectedHeadSha: "0000000000000000000000000000000000000000",
      }),
    ).toThrow(HeadShaMismatchError);
  });

  test("a null expectedHeadSha is permissive (first run, no sha recorded yet)", () => {
    expect(() =>
      verifyHeadSha({
        repoPath: local.dir,
        branch,
        expectedHeadSha: null,
      }),
    ).not.toThrow();
  });

  // Issue #102 — `state.head_sha` is recorded BEFORE the round's
  // finalize bookkeeping commit opens, so after one finalize commit
  // `state.head_sha === HEAD~1`. The checker must accept that shape,
  // but only when HEAD's subject actually looks like a finalize
  // commit — so unrelated drift still throws.
  test("accepts HEAD~1 when HEAD is a finalize bookkeeping commit", () => {
    const refineSha = runGit(["rev-parse", "HEAD"], local.dir).trim();
    // Open a follow-up commit with the exact `finalize` subject
    // grammar produced by `buildCommitMessage` in src/git/commit.ts.
    writeFileSync(join(local.dir, "bookkeeping.txt"), "state\n");
    runGit(["add", "bookkeeping.txt"], local.dir);
    runGit(
      ["commit", "-m", "spec(refunds): finalize round 1"],
      local.dir,
    );
    expect(() =>
      verifyHeadSha({
        repoPath: local.dir,
        branch,
        expectedHeadSha: refineSha,
      }),
    ).not.toThrow();
  });

  test("rejects HEAD~1 match when HEAD subject is NOT a finalize commit", () => {
    const refineSha = runGit(["rev-parse", "HEAD"], local.dir).trim();
    // Add a non-finalize commit on top.
    writeFileSync(join(local.dir, "bookkeeping.txt"), "state\n");
    runGit(["add", "bookkeeping.txt"], local.dir);
    runGit(["commit", "-m", "random unrelated commit"], local.dir);
    expect(() =>
      verifyHeadSha({
        repoPath: local.dir,
        branch,
        expectedHeadSha: refineSha,
      }),
    ).toThrow(HeadShaMismatchError);
  });
});
