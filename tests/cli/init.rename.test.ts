// Copyright 2026 Nikolay Samokhvalov.

/**
 * Regression tests for the .samospec -> .samo rename.
 * These assert that `samospec init` creates `.samo/` and does NOT
 * create `.samospec/`. They serve as a red guard: if the rename is
 * ever accidentally reverted, these tests fail immediately.
 *
 * Red-first rationale: written when the rename was incomplete;
 * they fail against the pre-fix code (which wrote `.samospec/`)
 * and pass after the bulk rename in src/ is applied.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runInit } from "../../src/cli/init.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-rename-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("samospec init — rename regression (.samospec -> .samo)", () => {
  test("creates .samo/ not .samospec/ (rename regression)", () => {
    const result = runInit({ cwd: tmp });

    expect(result.exitCode).toBe(0);

    // The renamed directory MUST exist.
    expect(existsSync(path.join(tmp, ".samo"))).toBe(true);
    expect(existsSync(path.join(tmp, ".samo", "config.json"))).toBe(true);
    expect(existsSync(path.join(tmp, ".samo", ".gitignore"))).toBe(true);

    // The old directory MUST NOT exist.
    expect(existsSync(path.join(tmp, ".samospec"))).toBe(false);
    expect(existsSync(path.join(tmp, ".samospec", "config.json"))).toBe(false);
  });

  test("stdout references .samo/ not .samospec/", () => {
    const result = runInit({ cwd: tmp });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(".samo");
    // Must NOT mention the old name.
    expect(result.stdout).not.toContain(".samospec");
  });
});
