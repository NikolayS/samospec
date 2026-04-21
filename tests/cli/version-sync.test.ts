// Copyright 2026 Nikolay Samokhvalov.

/**
 * Tests for #57: version sync.
 *
 * 1. Regression: `samospec version` output matches package.json "version".
 * 2. bump-version script: updates package.json + CHANGELOG stub.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { runCli } from "../../src/cli.ts";

// The package.json lives at the repo root — two levels up from tests/cli/.
const PACKAGE_JSON_PATH = path.resolve(import.meta.dir, "../../package.json");

const BUMP_SCRIPT_PATH = path.resolve(
  import.meta.dir,
  "../../scripts/bump-version.ts",
);

describe("version regression (#57)", () => {
  test("samospec version matches package.json version field", async () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
      version: string;
    };
    const result = await runCli(["version"]);
    expect(result.stdout.trim()).toBe(pkg.version);
  });
});

describe("bump-version script (#57)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "samospec-bump-version-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("script exists at scripts/bump-version.ts", () => {
    expect(existsSync(BUMP_SCRIPT_PATH)).toBe(true);
  });

  test("bumps package.json version to target", () => {
    // Copy a minimal package.json fixture into tmp.
    const fixturePkg = JSON.stringify(
      { name: "samospec", version: "0.2.0" },
      null,
      2,
    );
    const fixturePkgPath = path.join(tmp, "package.json");
    writeFileSync(fixturePkgPath, fixturePkg, "utf8");

    // Run the script against the fixture dir.
    const res = spawnSync(
      "bun",
      [BUMP_SCRIPT_PATH, "0.3.0", "--pkg", fixturePkgPath],
      { cwd: tmp, encoding: "utf8" },
    );
    expect(res.status).toBe(0);

    const updated = JSON.parse(readFileSync(fixturePkgPath, "utf8")) as {
      version: string;
    };
    expect(updated.version).toBe("0.3.0");
  });

  test("creates CHANGELOG entry for the new version", () => {
    const fixturePkg = JSON.stringify(
      { name: "samospec", version: "0.2.0" },
      null,
      2,
    );
    const fixturePkgPath = path.join(tmp, "package.json");
    const fixtureChangelogPath = path.join(tmp, "CHANGELOG.md");
    writeFileSync(fixturePkgPath, fixturePkg, "utf8");
    writeFileSync(
      fixtureChangelogPath,
      "# Changelog\n\n## [0.2.0] - 2026-04-01\n\n- Previous release.\n",
      "utf8",
    );

    const res = spawnSync(
      "bun",
      [
        BUMP_SCRIPT_PATH,
        "0.3.0",
        "--pkg",
        fixturePkgPath,
        "--changelog",
        fixtureChangelogPath,
      ],
      { cwd: tmp, encoding: "utf8" },
    );
    expect(res.status).toBe(0);

    const changelog = readFileSync(fixtureChangelogPath, "utf8");
    expect(changelog).toContain("## [0.3.0]");
    // Should include the current date in ISO format.
    expect(changelog).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
