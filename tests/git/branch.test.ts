// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createSpecBranch } from "../../src/git/branch.ts";
import { createTempRepo, type TempRepo } from "./helpers/tempRepo.ts";

describe("createSpecBranch — happy paths", () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = createTempRepo({ initialBranch: "feature-x" });
  });
  afterEach(() => {
    repo.cleanup();
  });

  test("creates samospec/<slug> off the current non-protected branch and checks it out", () => {
    createSpecBranch("refunds", { repoPath: repo.dir });
    expect(repo.currentBranch()).toBe("samospec/refunds");
    expect(repo.listBranches()).toContain("samospec/refunds");
    expect(repo.listBranches()).toContain("feature-x");
  });

  test("branches from the CURRENT branch, not from main/master by default", () => {
    // Sit on a side branch with a distinct commit so parentage is verifiable.
    repo.write("x.txt", "x\n");
    repo.run(["add", "x.txt"]);
    repo.run(["commit", "-m", "chore: add x on feature-x"]);
    const featureSha = repo.git("rev-parse", "HEAD");

    createSpecBranch("promo", { repoPath: repo.dir });
    const specSha = repo.git("rev-parse", "HEAD");
    expect(specSha).toBe(featureSha);
  });
});

describe("createSpecBranch — refuses on protected branches", () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = createTempRepo({ initialBranch: "main" });
  });
  afterEach(() => {
    repo.cleanup();
  });

  test("throws a protected-branch error when current branch is hardcoded-protected", () => {
    expect(() =>
      createSpecBranch("refunds", { repoPath: repo.dir }),
    ).toThrowError(/protected/i);
  });

  test("the thrown error exposes exitCode 2 per SPEC §8", () => {
    let caught: unknown;
    try {
      createSpecBranch("refunds", { repoPath: repo.dir });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(
      (caught as { readonly exitCode?: unknown }).exitCode,
    ).toBe(2);
  });

  test("does not create the spec branch when the current branch is protected", () => {
    try {
      createSpecBranch("refunds", { repoPath: repo.dir });
    } catch {
      /* expected */
    }
    expect(repo.listBranches()).not.toContain("samospec/refunds");
    // still on main
    expect(repo.currentBranch()).toBe("main");
  });

  test("also refuses when current branch is protected only via user config", () => {
    repo.run(["checkout", "-b", "staging"]);
    expect(() =>
      createSpecBranch("hotfix", {
        repoPath: repo.dir,
        userConfig: { git: { protected_branches: ["staging"] } },
      }),
    ).toThrowError(/protected/i);
  });

  test("also refuses when current branch is protected only via git config", () => {
    repo.run(["checkout", "-b", "release/1"]);
    repo.run(["config", "branch.release/1.protected", "true"]);
    expect(() =>
      createSpecBranch("hotfix", { repoPath: repo.dir }),
    ).toThrowError(/protected/i);
  });
});

describe("createSpecBranch — slug validation and idempotency", () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = createTempRepo({ initialBranch: "feature-x" });
  });
  afterEach(() => {
    repo.cleanup();
  });

  test("rejects an empty slug", () => {
    expect(() => createSpecBranch("", { repoPath: repo.dir })).toThrowError(
      /slug/i,
    );
  });

  test("rejects a slug containing whitespace or slashes", () => {
    expect(() =>
      createSpecBranch("bad slug", { repoPath: repo.dir }),
    ).toThrowError(/slug/i);
    expect(() =>
      createSpecBranch("a/b", { repoPath: repo.dir }),
    ).toThrowError(/slug/i);
  });

  test("rejects re-creating an existing samospec/<slug> branch", () => {
    createSpecBranch("refunds", { repoPath: repo.dir });
    repo.run(["checkout", "feature-x"]);
    expect(() =>
      createSpecBranch("refunds", { repoPath: repo.dir }),
    ).toThrowError(/already exists/i);
  });
});
