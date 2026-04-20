// Copyright 2026 Nikolay Samokhvalov.

/**
 * `publishLint(spec, repoState)` — returns hard + soft warnings per
 * SPEC §14 "Hallucinated repo facts (publish lint, broadened)".
 *
 * **Hard** (definitely wrong — surfaced prominently in the PR body):
 *   - `missing-path`: a path referenced in the spec (per extractor
 *     rules) does not exist under `repoState.repoRoot`.
 *
 * **Soft** (heuristic — surfaced lower):
 *   - `unknown-command`: first token of a `bash`/`sh`/`shell` fence
 *     line is not in the hardcoded allowlist nor the user-extended
 *     `publish_lint.allowed_commands` config. `$PATH` is **not**
 *     consulted (user-controlled; security concern per SPEC §14).
 *   - `ghost-branch`: branch-like name (`<word>/<word>` or a known
 *     short branch like `main`) is not in `repoState.branches` or
 *     `repoState.protectedBranches`.
 *   - `adapter-drift`: adapter/model id in prose not in
 *     `repoState.adapterModels`.
 *
 * Extraction helpers live in `./lint-extractors.ts`; types in
 * `./lint-types.ts`.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import {
  extractAdapterRefs,
  extractBranchRefs,
  extractCommands,
  extractPaths,
} from "./lint-extractors.ts";
import type {
  LintFinding,
  PublishLintReport,
  RepoState,
} from "./lint-types.ts";

/**
 * Extensions that make a `<word>/<...>` token unambiguously a file path.
 * `samospec/refunds` lacks an extension → prefer the branch
 * interpretation; `src/foo.ts` has one → unambiguously a path.
 */
const KNOWN_FILE_EXTENSIONS =
  /\.(?:md|json|ts|js|sql|py|rs|go|yaml|yml|toml|sh)$/;
const BRANCH_PAIR = /^[A-Za-z][\w-]*\/[\w./-]+$/;

/**
 * A candidate from `extractPaths` that matches `<word>/<slug>` with no
 * known file extension is treated as a branch candidate, not a path.
 * The SPEC's branch rule explicitly says "skip matches that are file
 * paths"; the converse is intentionally enforced here so the two
 * warning channels never double-count the same token.
 */
function prefersBranchInterpretation(token: string): boolean {
  if (KNOWN_FILE_EXTENSIONS.test(token)) return false;
  return BRANCH_PAIR.test(token);
}

/**
 * Hardcoded command allowlist per SPEC §14. These are the binaries
 * `samospec` itself orchestrates or embeds examples of. Any user
 * extension layers on top via `publish_lint.allowed_commands`.
 */
export const HARDCODED_COMMAND_ALLOWLIST: readonly string[] = [
  "samospec",
  "git",
  "gh",
  "glab",
  "bun",
  "node",
  "claude",
  "codex",
];

/**
 * Run the publish lint. Pure function w.r.t. the inputs plus the repo
 * file system (existence check on `repoState.repoRoot`). `$PATH` is
 * deliberately NOT consulted — a malicious `PATH` entry must not be
 * able to silence a command warning.
 */
export function publishLint(
  spec: string,
  repoState: RepoState,
): PublishLintReport {
  const hard: LintFinding[] = [];
  const soft: LintFinding[] = [];

  // --- Hard: missing paths --------------------------------------------
  for (const entry of extractPaths(spec)) {
    if (prefersBranchInterpretation(entry.path)) continue;
    const abs = path.join(repoState.repoRoot, entry.path);
    if (!existsSync(abs)) {
      hard.push({
        kind: "missing-path",
        message: `missing path referenced in spec: ${entry.path}`,
        location: { line: entry.line },
      });
    }
  }

  // --- Soft: unknown commands -----------------------------------------
  const userAllowed = new Set<string>(
    repoState.config.publish_lint?.allowed_commands ?? [],
  );
  const allowed = new Set<string>([
    ...HARDCODED_COMMAND_ALLOWLIST,
    ...userAllowed,
  ]);
  const seenUnknownCommand = new Set<string>();
  for (const entry of extractCommands(spec)) {
    if (allowed.has(entry.command)) continue;
    if (seenUnknownCommand.has(entry.command)) continue;
    seenUnknownCommand.add(entry.command);
    soft.push({
      kind: "unknown-command",
      message: `unknown command in shell fence: ${entry.command}`,
      location: { line: entry.line },
    });
  }

  // --- Soft: ghost branches -------------------------------------------
  const knownBranches = new Set<string>([
    ...repoState.branches,
    ...repoState.protectedBranches,
  ]);
  // Per SPEC §14 "Skip matches that are clearly file paths" — an
  // unambiguous file path (token ends in a known file extension) is
  // never reported as a ghost branch.
  for (const entry of extractBranchRefs(spec)) {
    if (KNOWN_FILE_EXTENSIONS.test(entry.branch)) continue;
    if (knownBranches.has(entry.branch)) continue;
    soft.push({
      kind: "ghost-branch",
      message: `ghost branch reference: ${entry.branch}`,
      location: { line: entry.line },
    });
  }

  // --- Soft: adapter / model drift ------------------------------------
  const known = new Set<string>(repoState.adapterModels);
  const seenModel = new Set<string>();
  for (const entry of extractAdapterRefs(spec)) {
    if (known.has(entry.model)) continue;
    if (seenModel.has(entry.model)) continue;
    seenModel.add(entry.model);
    soft.push({
      kind: "adapter-drift",
      message: `adapter/model not in resolved state: ${entry.model}`,
      location: { line: entry.line },
    });
  }

  return { hardWarnings: hard, softWarnings: soft };
}
