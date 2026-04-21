// Copyright 2026 Nikolay Samokhvalov.

// RED e2e CLI tests for #79 — `runInitCommand` must pass `--yes`
// through to `runInit` so that the auto-git-init path fires when the
// user runs `samospec init --yes` in a directory with no `.git`.
//
// These tests exercise the full `runCli` → `runInitCommand` → `runInit`
// path, NOT the `runInit` unit in isolation. The unit tests
// (tests/cli/init-auto-git.test.ts) already passed on main — the bug
// is that the CLI entry never forwarded the flag.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Run the CLI entry directly (not via subprocess) so we can change cwd.
// We drive it via the real src/main.ts as a subprocess so the working
// directory is respected, matching how a real user invokes the tool.
const CLI_PATH = path.resolve(
  import.meta.dir,
  "..",
  "..",
  "src",
  "main.ts",
);

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-autogit-e2e-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function runCli(
  args: readonly string[],
  cwd: string,
): { stdout: string; stderr: string; status: number } {
  const bun = Bun.argv[0];
  const result = spawnSync(bun, ["run", CLI_PATH, ...(args as string[])], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
    timeout: 15_000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

function hasGitDir(dir: string): boolean {
  return existsSync(path.join(dir, ".git"));
}

function headCommit(dir: string): string | null {
  const res = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env },
  });
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

function commitCount(dir: string): number {
  const res = spawnSync("git", ["rev-list", "--count", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env },
  });
  if (res.status !== 0) return 0;
  return parseInt(res.stdout.trim(), 10);
}

// RED: Must fail on current main because `runInitCommand` passes
// `{ cwd }` to `runInit` without forwarding `--yes`.
describe("#79 — e2e CLI: `samospec init --yes` in a dir with no .git", () => {
  test("creates .git/ directory", () => {
    expect(hasGitDir(tmp)).toBe(false);

    const result = runCli(["init", "--yes"], tmp);

    // Exit 0 — init must succeed.
    expect(result.status).toBe(0);
    // .git must exist (the CLI wired --yes → auto-init).
    expect(hasGitDir(tmp)).toBe(true);
  });

  test("creates exactly 1 initial commit", () => {
    expect(hasGitDir(tmp)).toBe(false);

    runCli(["init", "--yes"], tmp);

    // HEAD must be resolvable (commit was created).
    const head = headCommit(tmp);
    expect(head).not.toBeNull();
    // Exactly 1 commit (the initial empty commit from git-init helper).
    expect(commitCount(tmp)).toBe(1);
  });

  test("also creates .samo/ alongside .git/", () => {
    runCli(["init", "--yes"], tmp);

    expect(existsSync(path.join(tmp, ".samo"))).toBe(true);
    expect(existsSync(path.join(tmp, ".samo", "config.json"))).toBe(true);
  });

  test("stdout mentions git repo creation", () => {
    const result = runCli(["init", "--yes"], tmp);
    // The runInit helper emits "created git repo and initial commit".
    expect(result.stdout.toLowerCase()).toMatch(
      /created git repo|git init|git repo/,
    );
  });
});
