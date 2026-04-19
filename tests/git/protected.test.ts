// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { isProtected } from "../../src/git/protected.ts";
import { createTempRepo, type TempRepo } from "./helpers/tempRepo.ts";

describe("isProtected — hardcoded list", () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = createTempRepo({ initialBranch: "main" });
  });
  afterEach(() => {
    repo.cleanup();
  });

  test.each(["main", "master", "develop", "trunk"])(
    "marks '%s' as protected by the hardcoded list",
    (name) => {
      expect(isProtected(name, { repoPath: repo.dir })).toBe(true);
    },
  );

  test("does not mark unrelated names as protected", () => {
    expect(isProtected("feature/foo", { repoPath: repo.dir })).toBe(false);
    expect(isProtected("samospec/refunds", { repoPath: repo.dir })).toBe(false);
  });
});

describe("isProtected — git config branch.<name>.protected", () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = createTempRepo({ initialBranch: "main" });
  });
  afterEach(() => {
    repo.cleanup();
  });

  test("respects 'true' value on a non-hardcoded branch", () => {
    repo.run(["branch", "release/42"]);
    repo.run(["config", "branch.release/42.protected", "true"]);
    expect(isProtected("release/42", { repoPath: repo.dir })).toBe(true);
  });

  test("ignores 'false' value (only the hardcoded/user-config sources override)", () => {
    repo.run(["branch", "feature/ok"]);
    repo.run(["config", "branch.feature/ok.protected", "false"]);
    expect(isProtected("feature/ok", { repoPath: repo.dir })).toBe(false);
  });

  test("does not weaken hardcoded protection when the config says false", () => {
    repo.run(["config", "branch.main.protected", "false"]);
    expect(isProtected("main", { repoPath: repo.dir })).toBe(true);
  });
});

describe("isProtected — user config git.protected_branches", () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = createTempRepo({ initialBranch: "main" });
  });
  afterEach(() => {
    repo.cleanup();
  });

  test("respects a branch named in the user protected_branches list", () => {
    expect(
      isProtected("staging", {
        repoPath: repo.dir,
        userConfig: { git: { protected_branches: ["staging"] } },
      }),
    ).toBe(true);
  });

  test("does not mark a branch not in the user list (and not hardcoded)", () => {
    expect(
      isProtected("feature/xyz", {
        repoPath: repo.dir,
        userConfig: { git: { protected_branches: ["staging"] } },
      }),
    ).toBe(false);
  });
});

describe("isProtected — precedence: OR across all local sources", () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = createTempRepo({ initialBranch: "main" });
  });
  afterEach(() => {
    repo.cleanup();
  });

  test("any of (hardcoded | git config | user config) triggers protection", () => {
    // Branch protected only via user config.
    expect(
      isProtected("staging", {
        repoPath: repo.dir,
        userConfig: { git: { protected_branches: ["staging"] } },
      }),
    ).toBe(true);

    // Branch protected only via git config.
    repo.run(["branch", "release"]);
    repo.run(["config", "branch.release.protected", "true"]);
    expect(isProtected("release", { repoPath: repo.dir })).toBe(true);

    // Branch protected only via hardcoded list.
    expect(isProtected("trunk", { repoPath: repo.dir })).toBe(true);
  });
});
