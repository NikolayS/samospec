// Copyright 2026 Nikolay Samokhvalov.

// Contract tests for the config-aware path resolver. The resolver
// underpins both the new `samospec brief` command and the upcoming
// `.samo/spec/` → `samospec/spec/` rename — getting the contract
// nailed down here is what makes the rename safe later.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_BLUEPRINTS_DIR_REL,
  DEFAULT_SPEC_DIR_REL,
  blueprintSlugDir,
  blueprintSpecPath,
  briefHtmlPath,
  resolvePaths,
  specSlugDir,
} from "../src/paths.ts";

function tmpRepo(): string {
  return mkdtempSync(path.join(tmpdir(), "samospec-paths-"));
}

function writeConfig(repo: string, body: unknown): void {
  mkdirSync(path.join(repo, ".samo"), { recursive: true });
  writeFileSync(
    path.join(repo, ".samo", "config.json"),
    JSON.stringify(body, null, 2),
    "utf8",
  );
}

describe("resolvePaths — defaults", () => {
  test("with no config file, returns the legacy `.samo/spec` and `blueprints` defaults", () => {
    const repo = tmpRepo();
    const out = resolvePaths(repo);
    expect(out.specDir).toBe(path.join(repo, DEFAULT_SPEC_DIR_REL));
    expect(out.blueprintsDir).toBe(path.join(repo, DEFAULT_BLUEPRINTS_DIR_REL));
    expect(out.specDirRel).toBe(DEFAULT_SPEC_DIR_REL);
    expect(out.blueprintsDirRel).toBe(DEFAULT_BLUEPRINTS_DIR_REL);
  });

  test("with a config file that lacks a `paths` section, returns defaults", () => {
    const repo = tmpRepo();
    writeConfig(repo, { schema_version: 1 });
    const out = resolvePaths(repo);
    expect(out.specDirRel).toBe(DEFAULT_SPEC_DIR_REL);
    expect(out.blueprintsDirRel).toBe(DEFAULT_BLUEPRINTS_DIR_REL);
  });

  test("with an empty `paths` object, returns defaults", () => {
    const repo = tmpRepo();
    writeConfig(repo, { schema_version: 1, paths: {} });
    const out = resolvePaths(repo);
    expect(out.specDirRel).toBe(DEFAULT_SPEC_DIR_REL);
    expect(out.blueprintsDirRel).toBe(DEFAULT_BLUEPRINTS_DIR_REL);
  });
});

describe("resolvePaths — config overrides", () => {
  test("`paths.spec_dir` overrides the spec directory", () => {
    const repo = tmpRepo();
    writeConfig(repo, {
      schema_version: 1,
      paths: { spec_dir: "samospec/spec" },
    });
    const out = resolvePaths(repo);
    expect(out.specDir).toBe(path.join(repo, "samospec", "spec"));
    expect(out.specDirRel).toBe("samospec/spec");
    // blueprints stays at its default
    expect(out.blueprintsDirRel).toBe(DEFAULT_BLUEPRINTS_DIR_REL);
  });

  test("`paths.blueprints_dir` overrides the blueprints directory", () => {
    const repo = tmpRepo();
    writeConfig(repo, {
      schema_version: 1,
      paths: { blueprints_dir: "docs/specs" },
    });
    const out = resolvePaths(repo);
    expect(out.blueprintsDir).toBe(path.join(repo, "docs", "specs"));
    expect(out.blueprintsDirRel).toBe("docs/specs");
    expect(out.specDirRel).toBe(DEFAULT_SPEC_DIR_REL);
  });

  test("both overrides take effect simultaneously", () => {
    const repo = tmpRepo();
    writeConfig(repo, {
      schema_version: 1,
      paths: {
        spec_dir: "samospec/spec",
        blueprints_dir: "samospec/blueprints",
      },
    });
    const out = resolvePaths(repo);
    expect(out.specDir).toBe(path.join(repo, "samospec", "spec"));
    expect(out.blueprintsDir).toBe(path.join(repo, "samospec", "blueprints"));
  });

  test("a single-segment override (e.g. `blueprints` to `public`) works", () => {
    const repo = tmpRepo();
    writeConfig(repo, {
      schema_version: 1,
      paths: { blueprints_dir: "public" },
    });
    const out = resolvePaths(repo);
    expect(out.blueprintsDir).toBe(path.join(repo, "public"));
  });
});

describe("resolvePaths — validation", () => {
  test("rejects an absolute `spec_dir`", () => {
    const repo = tmpRepo();
    writeConfig(repo, {
      schema_version: 1,
      paths: { spec_dir: "/etc/samospec" },
    });
    expect(() => resolvePaths(repo)).toThrow(/repo-relative path/);
  });

  test("rejects an absolute `blueprints_dir`", () => {
    const repo = tmpRepo();
    writeConfig(repo, {
      schema_version: 1,
      paths: { blueprints_dir: "/var/samospec" },
    });
    expect(() => resolvePaths(repo)).toThrow(/repo-relative path/);
  });

  test("rejects a `spec_dir` that escapes the repo via `..`", () => {
    const repo = tmpRepo();
    writeConfig(repo, {
      schema_version: 1,
      paths: { spec_dir: "../escape" },
    });
    expect(() => resolvePaths(repo)).toThrow(/inside the repo/);
  });

  test("rejects a `spec_dir` that climbs and re-enters", () => {
    const repo = tmpRepo();
    writeConfig(repo, {
      schema_version: 1,
      paths: { spec_dir: "foo/../../bar" },
    });
    expect(() => resolvePaths(repo)).toThrow(/inside the repo/);
  });

  test("rejects an empty `spec_dir`", () => {
    const repo = tmpRepo();
    writeConfig(repo, {
      schema_version: 1,
      paths: { spec_dir: "" },
    });
    expect(() => resolvePaths(repo)).toThrow();
  });

  test("rejects a non-object `paths` field", () => {
    const repo = tmpRepo();
    writeConfig(repo, { schema_version: 1, paths: "samospec/spec" });
    expect(() => resolvePaths(repo)).toThrow(/must be a JSON object/);
  });

  test("rejects a malformed JSON config file", () => {
    const repo = tmpRepo();
    mkdirSync(path.join(repo, ".samo"), { recursive: true });
    writeFileSync(
      path.join(repo, ".samo", "config.json"),
      "{ not valid json",
      "utf8",
    );
    expect(() => resolvePaths(repo)).toThrow(/not valid JSON/);
  });

  test("rejects unknown keys inside `paths`", () => {
    const repo = tmpRepo();
    writeConfig(repo, {
      schema_version: 1,
      paths: { spec_dir: ".samo/spec", surprise: "boom" },
    });
    expect(() => resolvePaths(repo)).toThrow();
  });
});

describe("path helpers compose with the resolver", () => {
  test("specSlugDir respects the configured spec_dir", () => {
    const repo = tmpRepo();
    writeConfig(repo, {
      schema_version: 1,
      paths: { spec_dir: "samospec/spec" },
    });
    expect(specSlugDir(repo, "alpha")).toBe(
      path.join(repo, "samospec", "spec", "alpha"),
    );
  });

  test("blueprintSlugDir + blueprintSpecPath + briefHtmlPath all sit under blueprints_dir", () => {
    const repo = tmpRepo();
    writeConfig(repo, {
      schema_version: 1,
      paths: { blueprints_dir: "samospec/blueprints" },
    });
    const slug = "checkout";
    expect(blueprintSlugDir(repo, slug)).toBe(
      path.join(repo, "samospec", "blueprints", slug),
    );
    expect(blueprintSpecPath(repo, slug)).toBe(
      path.join(repo, "samospec", "blueprints", slug, "SPEC.md"),
    );
    expect(briefHtmlPath(repo, slug)).toBe(
      path.join(repo, "samospec", "blueprints", slug, "BRIEF.html"),
    );
  });

  test("with default config, briefHtmlPath sits under top-level `blueprints/<slug>/`", () => {
    const repo = tmpRepo();
    expect(briefHtmlPath(repo, "alpha")).toBe(
      path.join(repo, "blueprints", "alpha", "BRIEF.html"),
    );
  });
});
