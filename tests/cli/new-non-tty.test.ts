// Copyright 2026 Nikolay Samokhvalov.

// Issue #114 — `samospec new` MUST NOT call readline when stdin is not a
// TTY. The pre-fix behavior crashed with `ERR_USE_AFTER_CLOSE` at
// `proposePersonaInteractive`, blocking all CI / piped / background use.
//
// RED: with stdin fed from `/dev/null` and no automation flag
// (`--yes`, `--accept-persona`, `--answers-file`), `samospec new`
// MUST exit 1 quickly with a clear message — never throw readline
// internals.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI_PATH = path.resolve(import.meta.dir, "..", "..", "src", "main.ts");

let tmp: string;
let fakeHome: string;
let fakeBin: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-non-tty-"));
  fakeHome = mkdtempSync(path.join(tmpdir(), "samospec-non-tty-home-"));
  fakeBin = mkdtempSync(path.join(tmpdir(), "samospec-non-tty-bin-"));

  // Stub `claude` + `codex` with trivial returners so the adapter layer
  // is satisfied and we reach the persona-proposal / interview prompts.
  // They must never actually be called — the non-TTY guard fires first.
  const stubBody =
    '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then ' +
    "echo '0.0.0'; exit 0; fi\nsleep 60\n";
  for (const name of ["claude", "codex"]) {
    const p = path.join(fakeBin, name);
    writeFileSync(p, stubBody);
    chmodSync(p, 0o755);
  }

  // Init git + samospec in the sandbox.
  spawnSync("git", ["init", "--initial-branch", "work", tmp], {
    encoding: "utf8",
  });
  spawnSync("git", ["config", "user.email", "t@example.invalid"], { cwd: tmp });
  spawnSync("git", ["config", "user.name", "t"], { cwd: tmp });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: tmp });
  spawnSync("git", ["commit", "--allow-empty", "-m", "seed"], {
    cwd: tmp,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  runCli(["init", "--yes"]);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(fakeBin, { recursive: true, force: true });
});

function runCli(args: readonly string[]): {
  stdout: string;
  stderr: string;
  status: number;
  elapsedMs: number;
} {
  const bun = Bun.argv[0];
  const env: Record<string, string> = {
    PATH: `${fakeBin}:/usr/bin:/bin:/usr/local/bin`,
    HOME: fakeHome,
    NO_COLOR: "1",
    ANTHROPIC_API_KEY: "sk-fake-test-key",
  };
  // Pipe /dev/null on stdin so it's a non-TTY.
  const devNull = openSync("/dev/null", "r");
  const started = Date.now();
  try {
    const r = spawnSync(bun, ["run", CLI_PATH, ...(args as string[])], {
      cwd: tmp,
      encoding: "utf8",
      env,
      stdio: [devNull, "pipe", "pipe"],
      timeout: 15_000,
    });
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      status: r.status ?? 1,
      elapsedMs: Date.now() - started,
    };
  } finally {
    // spawnSync closes the fd itself, but be defensive.
  }
}

describe("samospec new — non-TTY stdin guard (#114)", () => {
  test("pipes /dev/null + no automation flag → exit 1 fast, actionable message", () => {
    const res = runCli(["new", "foo", "--idea", "x"]);
    // Must exit non-zero within a few seconds (never hang).
    expect(res.elapsedMs).toBeLessThan(12_000);
    expect(res.status).not.toBe(0);
    // Must not leak readline internals.
    expect(res.stderr).not.toContain("ERR_USE_AFTER_CLOSE");
    expect(res.stderr).not.toMatch(/node:readline/);
    // Actionable message: name the required flags.
    const stderr = res.stderr.toLowerCase();
    expect(stderr).toContain("tty");
    // At least one of the automation flags must be mentioned.
    const flagMentioned =
      stderr.includes("--yes") ||
      stderr.includes("--accept-persona") ||
      stderr.includes("--answers-file");
    expect(flagMentioned).toBe(true);
  });
});
