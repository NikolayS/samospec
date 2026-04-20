// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  buildGitLogMap,
  collectAuthorDates,
  parseGitLogBatch,
} from "../../src/context/git-meta.ts";
import { createTempRepo, type TempRepo } from "../git/helpers/tempRepo.ts";

describe("context/git-meta — parseGitLogBatch (SPEC §7)", () => {
  test("parses multi-entry --format='%at %H' --name-only output", () => {
    const raw = [
      "1700000000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "src/a.ts",
      "src/b.ts",
      "",
      "1700001000 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "src/a.ts",
      "",
    ].join("\n");
    const entries = parseGitLogBatch(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.sha).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(entries[0]?.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(entries[0]?.authoredAt).toBe(1700000000);
    expect(entries[1]?.files).toEqual(["src/a.ts"]);
  });

  test("buildGitLogMap yields last-authored-at per file", () => {
    const entries = [
      {
        authoredAt: 1000,
        sha: "a".repeat(40),
        files: ["x.ts", "y.ts"],
      },
      {
        authoredAt: 2000,
        sha: "b".repeat(40),
        files: ["x.ts"],
      },
    ];
    const map = buildGitLogMap(entries);
    expect(map.get("x.ts")).toBe(2000);
    expect(map.get("y.ts")).toBe(1000);
    expect(map.get("z.ts")).toBeUndefined();
  });
});

describe("context/git-meta — collectAuthorDates against temp repo", () => {
  let repo: TempRepo;

  beforeEach(() => {
    repo = createTempRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  test("single batched spawn produces correct map for tracked files", () => {
    // Initial commit already wrote README.md.
    repo.write("src/a.ts", "export const a = 1;\n");
    repo.run(["add", "src/a.ts"]);
    repo.run(["commit", "-m", "feat: add a"]);
    repo.write("src/b.ts", "export const b = 2;\n");
    repo.run(["add", "src/b.ts"]);
    repo.run(["commit", "-m", "feat: add b"]);

    const { map, spawnCount } = collectAuthorDates({ repoPath: repo.dir });

    expect(spawnCount).toBe(1);
    expect(map.get("src/a.ts")).toBeGreaterThan(0);
    expect(map.get("src/b.ts")).toBeGreaterThan(0);
    expect(map.get("README.md")).toBeGreaterThan(0);
  });

  test("single batched spawn regardless of repo size (~50 commits)", () => {
    for (let i = 0; i < 50; i++) {
      repo.write(
        `src/file-${String(i)}.ts`,
        `export const x = ${String(i)};\n`,
      );
      repo.run(["add", `src/file-${String(i)}.ts`]);
      repo.run(["commit", "-m", `feat: file ${String(i)}`]);
    }
    const { spawnCount } = collectAuthorDates({ repoPath: repo.dir });
    expect(spawnCount).toBe(1);
  });
});
