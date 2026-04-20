// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §8 — `git.fetch_timeout_seconds` default (5s). Extends the Sprint 1
 * `.samospec/config.json` schema. `git.remote_probe` stays at its Sprint 1
 * default of `false`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runInit } from "../../src/cli/init.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-fetch-timeout-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("init — git.fetch_timeout_seconds default (SPEC §8)", () => {
  test("writes git.fetch_timeout_seconds = 5 on a fresh init", () => {
    runInit({ cwd: tmp });
    const cfg = JSON.parse(
      readFileSync(path.join(tmp, ".samospec", "config.json"), "utf8"),
    ) as { git: { fetch_timeout_seconds: number; remote_probe: boolean } };
    expect(cfg.git.fetch_timeout_seconds).toBe(5);
    // Sprint 1 remote_probe default is untouched.
    expect(cfg.git.remote_probe).toBe(false);
  });

  test("merging preserves a user-set value and does not clobber it", () => {
    // Simulate an existing config that overrides the fetch timeout.
    const samoDir = path.join(tmp, ".samospec");
    const cfgPath = path.join(samoDir, "config.json");
    const preSeed = {
      schema_version: 1,
      git: {
        fetch_timeout_seconds: 30,
      },
    };
    // Write via fs rather than mkdir; runInit will handle directory creation.
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(samoDir, { recursive: true });
    writeFileSync(cfgPath, JSON.stringify(preSeed, null, 2), "utf8");

    runInit({ cwd: tmp });
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
      git: { fetch_timeout_seconds: number };
    };
    expect(cfg.git.fetch_timeout_seconds).toBe(30);
  });
});
