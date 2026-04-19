// Copyright 2026 Nikolay Samokhvalov.

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export interface TempRepo {
  readonly dir: string;
  readonly run: (
    args: readonly string[],
    opts?: { readonly cwd?: string; readonly allowFail?: boolean },
  ) => { stdout: string; stderr: string; status: number };
  readonly git: (...args: string[]) => string;
  readonly cleanup: () => void;
  readonly write: (relPath: string, contents: string) => void;
  readonly currentBranch: () => string;
  readonly listBranches: () => string[];
  readonly logOnBranch: (branch: string) => string[];
}

export function createTempRepo(
  options: { readonly initialBranch?: string } = {},
): TempRepo {
  const initialBranch = options.initialBranch ?? "main";
  const dir = mkdtempSync(join(tmpdir(), "samospec-git-test-"));

  const run: TempRepo["run"] = (args, opts) => {
    const cwd = opts?.cwd ?? dir;
    const result = spawnSync("git", args as string[], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Samospec Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Samospec Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    });
    if ((result.status ?? 1) !== 0 && !opts?.allowFail) {
      throw new Error(
        `git ${args.join(" ")} failed with status ${String(result.status)}: ${
          result.stderr
        }`,
      );
    }
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status ?? 0,
    };
  };

  const git: TempRepo["git"] = (...args) => {
    return run(args).stdout.trim();
  };

  // Initialize repo.
  run(["init", "--initial-branch", initialBranch, dir], { cwd: tmpdir() });
  run(["config", "user.name", "Samospec Test"]);
  run(["config", "user.email", "test@example.invalid"]);
  run(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "# Temp repo\n");
  run(["add", "README.md"]);
  run(["commit", "-m", "chore: initial"]);

  const write: TempRepo["write"] = (relPath, contents) => {
    const full = join(dir, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  };

  const currentBranch = () => git("rev-parse", "--abbrev-ref", "HEAD");
  const listBranches = () =>
    run(["branch", "--list", "--format=%(refname:short)"])
      .stdout.split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const logOnBranch = (branch: string) => {
    const result = run(["log", "--format=%s", branch], { allowFail: true });
    if (result.status !== 0) return [];
    return result.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  };

  const cleanup = () => {
    rmSync(dir, { recursive: true, force: true });
  };

  return {
    dir,
    run,
    git,
    cleanup,
    write,
    currentBranch,
    listBranches,
    logOnBranch,
  };
}
