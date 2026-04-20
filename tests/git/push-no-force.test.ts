// Copyright 2026 Nikolay Samokhvalov.

/**
 * Forbidden-flag regression specific to Sprint 4 #31's pushBranch helper.
 * tests/git/no-force.test.ts greps the src/git tree for dangerous
 * tokens; this suite exercises the runtime path to prove the argv that
 * reaches git push never carries one.
 *
 * Approach: shim the $PATH so `git push ...` resolves to a wrapper
 * script that records its argv to a file and exits 0. Then inspect the
 * recorded argv for forbidden tokens.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { pushBranch } from "../../src/git/push.ts";

const FORBIDDEN_TOKENS = [
  "--force",
  "--force-with-lease",
  "-f",
  "--no-verify",
  "+refs/",
];

let shimDir: string;
let argvLog: string;
let savedPath: string | undefined;

beforeEach(() => {
  shimDir = mkdtempSync(path.join(tmpdir(), "samospec-push-shim-"));
  argvLog = path.join(shimDir, "argv.log");
  // bash shim that records argv (one arg per line) and exits 0.
  const shimScript = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    `printf '%s\\n' "$@" > "${argvLog}"`,
    "exit 0",
  ].join("\n");
  writeFileSync(path.join(shimDir, "git"), shimScript, "utf8");
  chmodSync(path.join(shimDir, "git"), 0o755);
  savedPath = process.env["PATH"];
  process.env["PATH"] = `${shimDir}:${savedPath ?? ""}`;
});

afterEach(() => {
  if (savedPath !== undefined) {
    process.env["PATH"] = savedPath;
  } else {
    delete process.env["PATH"];
  }
  rmSync(shimDir, { recursive: true, force: true });
});

describe("pushBranch runtime argv: no forbidden flags", () => {
  test("argv observed by `git` contains exactly ['push', '<remote>', '<branch>']", () => {
    // Use a fake repoPath — the shim ignores cwd.
    const fakeRepo = mkdtempSync(path.join(tmpdir(), "samospec-push-repo-"));
    try {
      const result = pushBranch({
        repoPath: fakeRepo,
        remote: "origin",
        branch: "samospec/refunds",
        granted: true,
        noPush: false,
      });
      expect(result.state).toBe("pushed");
      const argv = readFileSync(argvLog, "utf8")
        .split("\n")
        .filter((l) => l.length > 0);
      expect(argv).toEqual(["push", "origin", "samospec/refunds"]);

      for (const token of FORBIDDEN_TOKENS) {
        for (const arg of argv) {
          expect(arg.includes(token)).toBe(false);
        }
      }
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });

  test("no invocation emitted when noPush=true (shim never runs)", () => {
    const fakeRepo = mkdtempSync(path.join(tmpdir(), "samospec-push-repo-"));
    try {
      const result = pushBranch({
        repoPath: fakeRepo,
        remote: "origin",
        branch: "samospec/refunds",
        granted: true,
        noPush: true,
      });
      expect(result.state).toBe("skipped-no-push");
      // argvLog wasn't created because the shim was never invoked.
      let exists = true;
      try {
        readFileSync(argvLog, "utf8");
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });

  test("no invocation emitted when granted=false", () => {
    const fakeRepo = mkdtempSync(path.join(tmpdir(), "samospec-push-repo-"));
    try {
      const result = pushBranch({
        repoPath: fakeRepo,
        remote: "origin",
        branch: "samospec/refunds",
        granted: false,
        noPush: false,
      });
      expect(result.state).toBe("skipped-refused");
      let exists = true;
      try {
        readFileSync(argvLog, "utf8");
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    } finally {
      rmSync(fakeRepo, { recursive: true, force: true });
    }
  });
});
