// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  buildDeterministicGist,
  computeBlobSha,
  gistCachePath,
  readOrCreateGist,
  parseImportsExports,
} from "../../src/context/gist.ts";
import { createTempRepo, type TempRepo } from "../git/helpers/tempRepo.ts";

describe("context/gist — computeBlobSha (SPEC §7)", () => {
  test("matches git's 40-char hex SHA-1 blob digest", () => {
    // git hash-object computes sha1("blob <size>\0<content>"). The empty
    // blob SHA is a well-known constant.
    expect(computeBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    // "hello" blob
    expect(computeBlobSha("hello")).toBe(
      "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0",
    );
  });
});

describe("context/gist — parseImportsExports (SPEC §7: cheap parse)", () => {
  test("extracts ts/js imports and named exports without executing code", () => {
    const src = [
      "import x from './x.ts';",
      "import { y, z } from './yz.ts';",
      "export const a = 1;",
      "export function b() {}",
      "const secret = 'notexported';",
    ].join("\n");
    const r = parseImportsExports(src, "src/file.ts");
    expect(r.imports).toContain("./x.ts");
    expect(r.imports).toContain("./yz.ts");
    expect(r.exports).toContain("a");
    expect(r.exports).toContain("b");
    expect(r.exports).not.toContain("secret");
  });

  test("extracts Python imports (cheap regex, no AST)", () => {
    const src = [
      "import os",
      "from pathlib import Path",
      "from .mod import x, y",
    ].join("\n");
    const r = parseImportsExports(src, "app.py");
    expect(r.imports).toContain("os");
    expect(r.imports).toContain("pathlib");
    expect(r.imports).toContain(".mod");
  });
});

describe("context/gist — buildDeterministicGist (SPEC §7)", () => {
  test("produces a Markdown gist with path / size / line count / author date", () => {
    const gist = buildDeterministicGist({
      path: "src/foo.ts",
      content: "import x from './x.ts';\nexport const foo = 1;\n",
      blobSha: "deadbeef00000000000000000000000000000000",
      authoredAt: 1700000000,
    });
    expect(gist).toContain("src/foo.ts");
    expect(gist).toContain("blob deadbeef00000000000000000000000000000000");
    expect(gist).toMatch(/lines: 2/i);
    expect(gist).toContain("2023-11-14"); // unix 1700000000 -> 2023-11-14
    expect(gist).toContain("./x.ts"); // import listed
    expect(gist).toContain("foo"); // export listed
  });

  test("is deterministic — same inputs produce byte-identical output", () => {
    const a = buildDeterministicGist({
      path: "src/x.ts",
      content: "export const x = 1;\n",
      blobSha: "a".repeat(40),
      authoredAt: 1_700_000_000,
    });
    const b = buildDeterministicGist({
      path: "src/x.ts",
      content: "export const x = 1;\n",
      blobSha: "a".repeat(40),
      authoredAt: 1_700_000_000,
    });
    expect(a).toBe(b);
  });
});

describe("context/gist — cache at .samospec/cache/gists/<blob-sha>.md", () => {
  let repo: TempRepo;

  beforeEach(() => {
    repo = createTempRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  test("cache path is blob-sha keyed under .samospec/cache/gists", () => {
    const full = gistCachePath(repo.dir, "abc123");
    expect(full).toBe(
      path.join(repo.dir, ".samospec", "cache", "gists", "abc123.md"),
    );
  });

  test("readOrCreateGist writes a fresh gist and reads it back verbatim", () => {
    const res = readOrCreateGist({
      repoPath: repo.dir,
      path: "src/x.ts",
      content: "export const x = 1;\n",
      authoredAt: 1_700_000_000,
    });
    expect(res.fromCache).toBe(false);
    expect(existsSync(res.cacheFile)).toBe(true);
    const written = readFileSync(res.cacheFile, "utf8");
    expect(written).toBe(res.gist);
    // Second call returns cached entry.
    const res2 = readOrCreateGist({
      repoPath: repo.dir,
      path: "src/x.ts",
      content: "export const x = 1;\n",
      authoredAt: 1_700_000_000,
    });
    expect(res2.fromCache).toBe(true);
    expect(res2.gist).toBe(res.gist);
    expect(res2.blobSha).toBe(res.blobSha);
  });

  test("file change -> new blob sha -> new cache entry (old survives)", () => {
    const resA = readOrCreateGist({
      repoPath: repo.dir,
      path: "src/x.ts",
      content: "export const x = 1;\n",
      authoredAt: 1_700_000_000,
    });
    const resB = readOrCreateGist({
      repoPath: repo.dir,
      path: "src/x.ts",
      content: "export const x = 2;\n", // different content
      authoredAt: 1_700_000_001,
    });
    expect(resA.blobSha).not.toBe(resB.blobSha);
    expect(resA.cacheFile).not.toBe(resB.cacheFile);
    // Both cache entries exist on disk.
    expect(existsSync(resA.cacheFile)).toBe(true);
    expect(existsSync(resB.cacheFile)).toBe(true);
    // And the first content is still intact (survives "branch switch"
    // by virtue of blob-hash keying).
    expect(readFileSync(resA.cacheFile, "utf8")).toBe(resA.gist);
  });
});
