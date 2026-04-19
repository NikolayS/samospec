// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildCommitMessage,
  specCommit,
  type CommitAction,
} from "../../src/git/commit.ts";
import { createTempRepo, type TempRepo } from "./helpers/tempRepo.ts";

describe("buildCommitMessage — grammar", () => {
  test("renders 'spec(<slug>): <action> v<version>' for a draft", () => {
    expect(
      buildCommitMessage({ slug: "refunds", action: "draft", version: "0.1" }),
    ).toBe("spec(refunds): draft v0.1");
  });

  test("renders a refine-with-round message", () => {
    expect(
      buildCommitMessage({
        slug: "refunds",
        action: "refine",
        version: "0.3",
        roundNumber: 2,
      }),
    ).toBe("spec(refunds): refine v0.3 after review r2");
  });

  test("supports the 'publish' action", () => {
    expect(
      buildCommitMessage({
        slug: "payments",
        action: "publish",
        version: "1.0",
      }),
    ).toBe("spec(payments): publish v1.0");
  });

  test("rejects an invalid slug", () => {
    expect(() =>
      buildCommitMessage({
        slug: "Bad Slug",
        action: "draft",
        version: "0.1",
      }),
    ).toThrowError(/slug/i);
  });

  test("rejects an invalid version", () => {
    expect(() =>
      buildCommitMessage({
        slug: "refunds",
        action: "draft",
        version: "v0.1",
      }),
    ).toThrowError(/version/i);
    expect(() =>
      buildCommitMessage({
        slug: "refunds",
        action: "draft",
        version: "",
      }),
    ).toThrowError(/version/i);
  });

  test("rejects an action not in the grammar", () => {
    expect(() =>
      buildCommitMessage({
        slug: "refunds",
        // @ts-expect-error — runtime check
        action: "YOLO",
        version: "0.1",
      }),
    ).toThrowError(/action/i);
  });

  test("rejects negative or non-integer roundNumber", () => {
    expect(() =>
      buildCommitMessage({
        slug: "refunds",
        action: "refine",
        version: "0.2",
        roundNumber: -1,
      }),
    ).toThrowError(/round/i);
    expect(() =>
      buildCommitMessage({
        slug: "refunds",
        action: "refine",
        version: "0.2",
        roundNumber: 1.5,
      }),
    ).toThrowError(/round/i);
  });

  test("exposes the list of known actions", () => {
    const actions: readonly CommitAction[] = [
      "draft",
      "refine",
      "publish",
      "user-edit",
      "changelog",
    ];
    for (const action of actions) {
      const msg = buildCommitMessage({
        slug: "refunds",
        action,
        version: "0.1",
      });
      expect(msg).toContain(action);
    }
  });
});

describe("specCommit — integration on a real repo", () => {
  let repo: TempRepo;
  beforeEach(() => {
    repo = createTempRepo({ initialBranch: "samospec/refunds" });
  });
  afterEach(() => {
    repo.cleanup();
  });

  test("writes a commit on the spec branch with the correct message", () => {
    repo.write("SPEC.md", "# Refunds v0.1\n");
    specCommit({
      repoPath: repo.dir,
      slug: "refunds",
      action: "draft",
      version: "0.1",
      paths: ["SPEC.md"],
    });
    const messages = repo.logOnBranch("samospec/refunds");
    expect(messages[0]).toBe("spec(refunds): draft v0.1");
  });

  test("refuses to commit when the current branch is protected", () => {
    // Create a new repo rooted on main.
    const main = createTempRepo({ initialBranch: "main" });
    try {
      main.write("SPEC.md", "# x\n");
      expect(() =>
        specCommit({
          repoPath: main.dir,
          slug: "refunds",
          action: "draft",
          version: "0.1",
          paths: ["SPEC.md"],
        }),
      ).toThrowError(/protected/i);

      // And no commit landed on main.
      const before = main.logOnBranch("main");
      expect(before.length).toBe(1); // only the initial chore commit
    } finally {
      main.cleanup();
    }
  });

  test("stages only the paths it's asked to stage (no 'add -A')", () => {
    repo.write("SPEC.md", "# Refunds v0.1\n");
    repo.write("unrelated.txt", "nope\n");
    specCommit({
      repoPath: repo.dir,
      slug: "refunds",
      action: "draft",
      version: "0.1",
      paths: ["SPEC.md"],
    });
    const show = repo
      .run(["show", "--name-only", "--format=", "HEAD"])
      .stdout.split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(show).toContain("SPEC.md");
    expect(show).not.toContain("unrelated.txt");
  });
});
