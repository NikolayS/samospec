// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import {
  classifyBucket,
  rankFiles,
  type ContextBucket,
} from "../../src/context/rank.ts";

describe("context/rank — bucket classification (SPEC §7)", () => {
  test("README.md and README.* -> 'readme'", () => {
    expect(classifyBucket("README.md", [])).toBe("readme");
    expect(classifyBucket("README.rst", [])).toBe("readme");
    expect(classifyBucket("README", [])).toBe("readme");
    expect(classifyBucket("CONTRIBUTING.md", [])).toBe("readme");
    // Nested directory README is still readme-bucket.
    expect(classifyBucket("packages/a/README.md", [])).toBe("readme");
  });

  test("manifests -> 'manifest', not lockfiles", () => {
    expect(classifyBucket("package.json", [])).toBe("manifest");
    expect(classifyBucket("Cargo.toml", [])).toBe("manifest");
    expect(classifyBucket("go.mod", [])).toBe("manifest");
    expect(classifyBucket("pyproject.toml", [])).toBe("manifest");
    expect(classifyBucket("requirements.txt", [])).toBe("manifest");
    expect(classifyBucket("requirements-dev.txt", [])).toBe("manifest");
    expect(classifyBucket("Gemfile", [])).toBe("manifest");
    // Lockfiles are NOT manifests (and are denylisted upstream, but bucket is 'other').
    expect(classifyBucket("package-lock.json", [])).toBe("other");
    expect(classifyBucket("Cargo.lock", [])).toBe("other");
    expect(classifyBucket("Gemfile.lock", [])).toBe("other");
  });

  test("top-level docs -> 'arch-docs'", () => {
    expect(classifyBucket("ARCHITECTURE.md", [])).toBe("arch-docs");
    expect(classifyBucket("docs/overview.md", [])).toBe("arch-docs");
    expect(classifyBucket("docs/nested/topic.md", [])).toBe("arch-docs");
    expect(classifyBucket("notes.adoc", [])).toBe("arch-docs");
  });

  test("user-selected source paths -> 'user-source'", () => {
    expect(classifyBucket("src/auth/login.ts", ["src/auth"])).toBe(
      "user-source",
    );
    expect(
      classifyBucket("src/billing/x.rs", ["src/auth", "src/billing"]),
    ).toBe("user-source");
    expect(classifyBucket("src/other/x.ts", ["src/auth"])).toBe("other");
  });

  test("everything else -> 'other'", () => {
    expect(classifyBucket("random.txt", [])).toBe("other");
    expect(classifyBucket("src/deeply/nested/util.ts", [])).toBe("other");
  });
});

describe("context/rank — rankFiles (SPEC §7)", () => {
  test("orders by bucket then by recency", () => {
    const authorDates = new Map<string, number>([
      ["README.md", 1_000],
      ["CONTRIBUTING.md", 2_000],
      ["package.json", 3_000],
      ["go.mod", 500],
      ["ARCHITECTURE.md", 4_000],
      ["docs/guide.md", 3_500],
      ["src/auth/login.ts", 5_000],
      ["src/util.ts", 6_000],
      ["scratch.txt", 10_000], // newest, but 'other' — bucket dominates
    ]);
    const paths = [
      "scratch.txt",
      "src/util.ts",
      "src/auth/login.ts",
      "docs/guide.md",
      "ARCHITECTURE.md",
      "go.mod",
      "package.json",
      "CONTRIBUTING.md",
      "README.md",
    ];
    const ranked = rankFiles({
      paths,
      authorDates,
      contextPaths: ["src/auth"],
    });
    const order = ranked.map((r) => r.path);
    // readme bucket first: within bucket, newer authordate beats older.
    expect(order.indexOf("CONTRIBUTING.md")).toBeLessThan(
      order.indexOf("README.md"),
    );
    // All readmes come before manifests.
    expect(order.indexOf("README.md")).toBeLessThan(
      order.indexOf("package.json"),
    );
    expect(order.indexOf("package.json")).toBeLessThan(
      order.indexOf("go.mod"), // both manifest; package.json newer
    );
    // manifests before arch-docs.
    expect(order.indexOf("go.mod")).toBeLessThan(
      order.indexOf("ARCHITECTURE.md"),
    );
    expect(order.indexOf("ARCHITECTURE.md")).toBeLessThan(
      order.indexOf("docs/guide.md"),
    );
    // arch-docs before user-source.
    expect(order.indexOf("docs/guide.md")).toBeLessThan(
      order.indexOf("src/auth/login.ts"),
    );
    // user-source before other.
    expect(order.indexOf("src/auth/login.ts")).toBeLessThan(
      order.indexOf("src/util.ts"),
    );
    // other sorted by recency (scratch.txt newest in 'other')
    expect(order.indexOf("scratch.txt")).toBeLessThan(
      order.indexOf("src/util.ts"),
    );
  });

  test("ordering stable for files with no authoredAt", () => {
    const authorDates = new Map<string, number>();
    const paths = ["c.md", "a.md", "b.md"];
    const ranked = rankFiles({
      paths,
      authorDates,
      contextPaths: [],
    });
    // All bucket 'other', no authoredAt; preserve input order.
    expect(ranked.map((r) => r.path)).toEqual(["c.md", "a.md", "b.md"]);
  });
});

describe("context/rank — ContextBucket values", () => {
  test("exports canonical bucket list", () => {
    const all: ContextBucket[] = [
      "readme",
      "manifest",
      "arch-docs",
      "user-source",
      "other",
    ];
    expect(all.length).toBe(5);
  });
});
