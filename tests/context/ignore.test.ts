// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  applyIgnore,
  DEFAULT_DENYLIST,
  loadSamospecIgnore,
  MAX_ASSET_BYTES,
  parseIgnorePatterns,
} from "../../src/context/ignore.ts";
import { createTempRepo, type TempRepo } from "../git/helpers/tempRepo.ts";

describe("context/ignore — patterns (SPEC §7)", () => {
  test("parseIgnorePatterns strips comments, blanks, and normalizes", () => {
    const raw = [
      "# comment",
      "",
      "   ",
      "dist/",
      "/build/",
      "!keep.md",
      "  # inline comment-looking literal with leading # escaped",
      "\\#literal-hash.md",
    ].join("\n");
    const parsed = parseIgnorePatterns(raw);
    const patterns = parsed.map((p) => p.source);
    expect(patterns).toContain("dist/");
    expect(patterns).toContain("/build/");
    expect(patterns).toContain("!keep.md");
    expect(patterns).toContain("#literal-hash.md");
    // The first-line comment is dropped (different wording from the
    // escaped-# literal pattern).
    expect(patterns).not.toContain("# comment");
  });

  test("DEFAULT_DENYLIST excludes node_modules/ and *.lock and *.min.*", () => {
    const names = DEFAULT_DENYLIST.map((p) => p.source);
    expect(names).toContain("node_modules/");
    expect(names).toContain("vendor/");
    expect(names).toContain("dist/");
    expect(names).toContain("build/");
    expect(names).toContain("*.lock");
    expect(names).toContain("*.min.*");
    expect(names).toContain("*.generated.*");
  });
});

describe("context/ignore — applyIgnore (SPEC §7)", () => {
  let repo: TempRepo;

  beforeEach(() => {
    repo = createTempRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  test("applies default denylist (node_modules/, dist/, *.lock, *.min.*)", () => {
    const files = [
      "src/index.ts",
      "node_modules/left-pad/index.js",
      "dist/bundle.js",
      "build/app.js",
      "package-lock.json", // matches *.lock... but only via .lock suffix? we use *.lock specifically
      "bun.lock",
      "app.min.js",
      "generated.generated.ts",
      "README.md",
    ];
    const result = applyIgnore({
      repoPath: repo.dir,
      paths: files,
      extraPatterns: [],
    });
    expect(result).toContain("src/index.ts");
    expect(result).toContain("README.md");
    expect(result).not.toContain("node_modules/left-pad/index.js");
    expect(result).not.toContain("dist/bundle.js");
    expect(result).not.toContain("build/app.js");
    expect(result).not.toContain("bun.lock");
    expect(result).not.toContain("app.min.js");
    expect(result).not.toContain("generated.generated.ts");
  });

  test("honors .samo-ignore patterns", () => {
    repo.write(".samo-ignore", "secret-dir/\n*.private\n");
    const files = [
      "src/a.ts",
      "secret-dir/nested/x.ts",
      "top-level.private",
      "README.md",
    ];
    const samoIgnore = loadSamospecIgnore(repo.dir);
    const result = applyIgnore({
      repoPath: repo.dir,
      paths: files,
      extraPatterns: samoIgnore,
    });
    expect(result).toContain("src/a.ts");
    expect(result).toContain("README.md");
    expect(result).not.toContain("secret-dir/nested/x.ts");
    expect(result).not.toContain("top-level.private");
  });

  test("ignores assets over MAX_ASSET_BYTES and binary files", () => {
    const big = "x".repeat(MAX_ASSET_BYTES + 100);
    repo.write("huge.asset", big);
    // A small binary-looking file (null byte triggers the binary detection).
    repo.write("logo.png", "\u0000PNG\u0000binaryish\u0000data");

    const files = ["src/keep.ts", "huge.asset", "logo.png", "README.md"];
    // Create keep.ts to have non-empty fixture.
    repo.write("src/keep.ts", "export const k = 1;\n");

    const result = applyIgnore({
      repoPath: repo.dir,
      paths: files,
      extraPatterns: [],
    });
    expect(result).toContain("src/keep.ts");
    expect(result).toContain("README.md");
    expect(result).not.toContain("huge.asset");
    expect(result).not.toContain("logo.png");
  });

  test("hard-coded no-read list CANNOT be overridden by .samo-ignore whitelist", () => {
    // User tries to negate-whitelist .env.
    repo.write(".samo-ignore", "!.env\n");
    repo.write(".env.staging", "SECRET=abc\n");
    const files = ["src/a.ts", ".env.staging"];
    const samoIgnore = loadSamospecIgnore(repo.dir);
    repo.write("src/a.ts", "export const a = 1;\n");
    const result = applyIgnore({
      repoPath: repo.dir,
      paths: files,
      extraPatterns: samoIgnore,
    });
    expect(result).toContain("src/a.ts");
    expect(result).not.toContain(".env.staging");
  });
});
