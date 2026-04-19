// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  AUTO_STASH_MESSAGE,
  autoStash,
  decideDirtyTree,
  detectDirtyTree,
  type DirtyChoice,
  type DirtyDecision,
  type DirtyTreeSnapshot,
} from "../../src/git/dirty.ts";
import { createTempRepo, type TempRepo } from "./helpers/tempRepo.ts";

describe("detectDirtyTree", () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = createTempRepo({ initialBranch: "samospec/refunds" });
  });
  afterEach(() => {
    repo.cleanup();
  });

  test("returns a clean snapshot on a fresh repo", () => {
    const snap = detectDirtyTree({ repoPath: repo.dir });
    expect(snap.dirty).toBe(false);
    expect(snap.tracked).toEqual([]);
    expect(snap.untracked).toEqual([]);
  });

  test("detects a modified tracked file", () => {
    repo.write("README.md", "# Modified\n");
    const snap = detectDirtyTree({ repoPath: repo.dir });
    expect(snap.dirty).toBe(true);
    expect(snap.tracked).toContain("README.md");
    expect(snap.untracked).toEqual([]);
  });

  test("detects a new untracked file", () => {
    repo.write("newfile.txt", "hi\n");
    const snap = detectDirtyTree({ repoPath: repo.dir });
    expect(snap.dirty).toBe(true);
    expect(snap.untracked).toContain("newfile.txt");
    expect(snap.tracked).toEqual([]);
  });
});

describe("decideDirtyTree — engineer mode (default)", () => {
  const dirty: DirtyTreeSnapshot = {
    dirty: true,
    tracked: ["SPEC.md"],
    untracked: [],
  };
  const clean: DirtyTreeSnapshot = { dirty: false, tracked: [], untracked: [] };

  test("returns 'proceed' when the tree is clean regardless of mode", () => {
    const decision = decideDirtyTree(clean, { mode: "engineer" });
    expect(decision.outcome).toBe("proceed");
  });

  test("requires a prompt when dirty in engineer mode", () => {
    const decision = decideDirtyTree(dirty, { mode: "engineer" });
    expect(decision.outcome).toBe("prompt");
    expect(decision.allowedChoices).toEqual([
      "stash-continue",
      "continue-anyway",
      "abort",
    ]);
    expect(decision.defaultChoice).toBe("stash-continue");
  });

  test.each([
    ["stash-continue", "stash-then-proceed"],
    ["continue-anyway", "proceed"],
    ["abort", "abort"],
  ] satisfies readonly (readonly [DirtyChoice, DirtyDecision["outcome"]])[])(
    "resolves engineer-mode choice %s to %s",
    (choice, expected) => {
      const decision = decideDirtyTree(dirty, {
        mode: "engineer",
        engineerChoice: choice,
      });
      expect(decision.outcome).toBe(expected);
    },
  );
});

describe("decideDirtyTree — guided mode", () => {
  const dirty: DirtyTreeSnapshot = {
    dirty: true,
    tracked: ["SPEC.md"],
    untracked: [],
  };

  test("halts by default on any dirtiness per SPEC §8", () => {
    const decision = decideDirtyTree(dirty, { mode: "guided" });
    expect(decision.outcome).toBe("halt");
  });

  test("ignores any engineerChoice passed in guided mode", () => {
    const decision = decideDirtyTree(dirty, {
      mode: "guided",
      engineerChoice: "continue-anyway",
    });
    expect(decision.outcome).toBe("halt");
  });
});

describe("autoStash", () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = createTempRepo({ initialBranch: "samospec/refunds" });
  });
  afterEach(() => {
    repo.cleanup();
  });

  test("uses 'git stash push -u' with the samospec marker message", () => {
    repo.write("SPEC.md", "work in progress\n");
    repo.write("untracked.txt", "hello\n");

    autoStash({ repoPath: repo.dir });

    // Tree should be clean now.
    const snap = detectDirtyTree({ repoPath: repo.dir });
    expect(snap.dirty).toBe(false);

    // Stash list must show our message.
    const stashMessages = repo
      .run(["stash", "list", "--format=%s"])
      .stdout.trim();
    expect(stashMessages).toContain(AUTO_STASH_MESSAGE);
  });

  test("preserves untracked files via -u (they come back on pop)", () => {
    repo.write("untracked.txt", "hello\n");
    autoStash({ repoPath: repo.dir });
    // Untracked file should be in the stash, not on disk.
    const stashContents = repo
      .run(["stash", "show", "--include-untracked", "--name-only", "stash@{0}"])
      .stdout.split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(stashContents).toContain("untracked.txt");
  });

  test("exports AUTO_STASH_MESSAGE matching SPEC §8 verbatim", () => {
    expect(AUTO_STASH_MESSAGE).toBe("samospec: auto-stash before spec");
  });
});
