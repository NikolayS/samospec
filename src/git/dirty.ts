// Copyright 2026 Nikolay Samokhvalov.

import { spawnSync } from "node:child_process";

export const AUTO_STASH_MESSAGE = "samospec: auto-stash before spec";

export interface DirtyTreeSnapshot {
  readonly dirty: boolean;
  /** Tracked files with any unstaged/staged modification. */
  readonly tracked: readonly string[];
  /** Untracked-but-not-ignored files. */
  readonly untracked: readonly string[];
}

export interface DetectDirtyTreeOpts {
  readonly repoPath: string;
}

/**
 * Snapshot the working tree dirtiness via `git status --porcelain=v1`.
 *
 * - Tracked entries: any code other than `??` / space-space contributes to
 *   `tracked`. (Modified, added, deleted, renamed, copied, unmerged.)
 * - Untracked entries (`??`) go to `untracked`.
 * - Ignored files (`!!`) are not surfaced — they never block a spec.
 */
export function detectDirtyTree(opts: DetectDirtyTreeOpts): DirtyTreeSnapshot {
  const result = spawnSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    { cwd: opts.repoPath, encoding: "utf8" },
  );
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `git status failed with status ${String(result.status)}: ${
        result.stderr ?? ""
      }`,
    );
  }

  const tracked: string[] = [];
  const untracked: string[] = [];

  const raw = result.stdout ?? "";
  for (const rawLine of raw.split("\n")) {
    if (rawLine.length === 0) continue;
    // Porcelain v1 line: 'XY path' where XY is 2 chars.
    const code = rawLine.slice(0, 2);
    const path = rawLine.slice(3);
    if (code === "??") {
      untracked.push(path);
    } else if (code !== "!!") {
      tracked.push(path);
    }
  }

  return {
    dirty: tracked.length > 0 || untracked.length > 0,
    tracked,
    untracked,
  };
}

/**
 * Prompt mode:
 *   - `engineer` (default CLI mode): user gets three options.
 *   - `guided` (via --explain): halt by default, never auto-stash.
 */
export type DirtyMode = "engineer" | "guided";

export type DirtyChoice = "stash-continue" | "continue-anyway" | "abort";

export interface DirtyDecision {
  readonly outcome:
    | "proceed"
    | "stash-then-proceed"
    | "abort"
    | "halt"
    | "prompt";
  readonly allowedChoices?: readonly DirtyChoice[];
  readonly defaultChoice?: DirtyChoice;
}

export interface DecideDirtyTreeOpts {
  readonly mode: DirtyMode;
  /**
   * When the caller has already resolved the engineer-mode prompt (from the
   * UI layer), pass the choice here. Without it, the decision is `prompt`.
   * The *prompt* itself is UI — not this module's concern — but the decision
   * handlers live here so they're testable without a TTY.
   */
  readonly engineerChoice?: DirtyChoice;
}

/**
 * Pure function: given a dirty-tree snapshot and the caller's mode/choice,
 * returns the next action. No side effects.
 *
 * Matrix (per SPEC §8):
 *
 *   clean tree        -> proceed
 *   guided mode       -> halt (ignore any engineerChoice)
 *   engineer mode, no choice provided yet -> prompt
 *   engineer + stash-continue   -> stash-then-proceed
 *   engineer + continue-anyway  -> proceed
 *   engineer + abort            -> abort
 */
export function decideDirtyTree(
  snap: DirtyTreeSnapshot,
  opts: DecideDirtyTreeOpts,
): DirtyDecision {
  if (!snap.dirty) return { outcome: "proceed" };

  if (opts.mode === "guided") return { outcome: "halt" };

  // engineer mode.
  if (opts.engineerChoice === undefined) {
    return {
      outcome: "prompt",
      allowedChoices: ["stash-continue", "continue-anyway", "abort"],
      defaultChoice: "stash-continue",
    };
  }

  switch (opts.engineerChoice) {
    case "stash-continue":
      return { outcome: "stash-then-proceed" };
    case "continue-anyway":
      return { outcome: "proceed" };
    case "abort":
      return { outcome: "abort" };
  }
}

export interface AutoStashOpts {
  readonly repoPath: string;
}

/**
 * SPEC §8: `git stash push -u -m "samospec: auto-stash before spec"`.
 *
 * `-u` preserves untracked files. We never use `--force` / `+refspec` /
 * `--no-verify` / `--amend` anywhere in this helper.
 */
export function autoStash(opts: AutoStashOpts): void {
  const result = spawnSync(
    "git",
    ["stash", "push", "-u", "-m", AUTO_STASH_MESSAGE],
    { cwd: opts.repoPath, encoding: "utf8" },
  );
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `git stash push failed with status ${String(result.status)}: ${
        result.stderr ?? ""
      }`,
    );
  }
}
