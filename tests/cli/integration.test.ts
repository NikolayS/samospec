// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Use main.ts — it's the actual CLI entrypoint that calls runCli.
// src/cli.ts is a library module that only exports runCli.
const CLI_PATH = path.resolve(import.meta.dir, "..", "..", "src", "main.ts");

let tmp: string;
let fakeHome: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-cli-integ-"));
  fakeHome = mkdtempSync(path.join(tmpdir(), "samospec-home-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

function runSamospec(
  args: readonly string[],
  opts: { cwd: string; env?: Record<string, string> },
): { stdout: string; stderr: string; status: number } {
  const env = {
    ...process.env,
    HOME: fakeHome,
    NO_COLOR: "1",
    ...(opts.env ?? {}),
  };
  // Prefer the running Bun interpreter so tests work regardless of whether
  // `bun` is on PATH (Bun.argv[0] is the absolute binary path).
  const bun = Bun.argv[0];
  const result = spawnSync(bun, ["run", CLI_PATH, ...(args as string[])], {
    cwd: opts.cwd,
    encoding: "utf8",
    env,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

describe("integration: bun run src/cli.ts init && doctor", () => {
  test("init creates .samospec/, doctor reports status and exits", () => {
    // Initialize a bare git repo so doctor's git check has something to see.
    spawnSync("git", ["init", "--initial-branch", "feature/integ", tmp], {
      cwd: tmpdir(),
      encoding: "utf8",
    });

    const initResult = runSamospec(["init"], { cwd: tmp });
    expect(initResult.status).toBe(0);
    expect(existsSync(path.join(tmp, ".samospec", "config.json"))).toBe(true);
    expect(existsSync(path.join(tmp, ".samospec", ".gitignore"))).toBe(true);

    const doctorResult = runSamospec(["doctor"], { cwd: tmp });
    // doctor may exit 0 or 1 depending on real claude/codex presence in CI.
    expect([0, 1]).toContain(doctorResult.status);
    // Key lines must always appear regardless of pass/fail.
    expect(doctorResult.stdout).toContain("CLI availability");
    expect(doctorResult.stdout).toContain("git");
    expect(doctorResult.stdout).toContain("lockfile");
    expect(doctorResult.stdout).toContain("config");
    expect(doctorResult.stdout).toContain("global vendor-config");
    expect(doctorResult.stdout).toContain("entropy");
  });

  test("second init run is idempotent and prints an up-to-date/merged message", () => {
    spawnSync("git", ["init", "--initial-branch", "feature/integ", tmp], {
      cwd: tmpdir(),
      encoding: "utf8",
    });

    const first = runSamospec(["init"], { cwd: tmp });
    expect(first.status).toBe(0);

    const second = runSamospec(["init"], { cwd: tmp });
    expect(second.status).toBe(0);
    // Some indication no changes were needed.
    expect(second.stdout.toLowerCase()).toMatch(
      /no changes|up to date|unchanged|no-op/,
    );
  });
});
