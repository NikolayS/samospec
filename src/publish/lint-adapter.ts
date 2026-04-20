// Copyright 2026 Nikolay Samokhvalov.

/**
 * Adapts the real `publishLint` (from `lint.ts`, SPEC §14) into the
 * `PublishLint` callable interface (from `lint-stub.ts`) so that
 * `samospec publish` can use the real lint while keeping the existing
 * body-composition layer's `PublishLintFinding` shape stable.
 *
 * Mapping:
 *   - `LintFinding.kind` → `PublishLintFinding.id`
 *   - `LintFinding.message` → `PublishLintFinding.message` (verbatim)
 *
 * `RepoState` is constructed from the spec path on disk: branches are
 * read via `git branch --list`, protected branches from the same
 * `isProtected` helper used elsewhere, and adapter models are not
 * available at publish time without a running session — the adapter-drift
 * check gracefully soft-warns only on tokens that match the drift heuristic,
 * so an empty `adapterModels` list is safe (no false negatives for hard
 * warnings; soft-warnings may be noisy but are non-blocking per §14).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { LintFinding } from "./lint-types.ts";
import type { PublishLintFinding, PublishLint } from "./lint-stub.ts";
import { publishLint } from "./lint.ts";

function findingToStub(f: LintFinding): PublishLintFinding {
  return { id: f.kind, message: f.message };
}

function localBranches(repoPath: string): string[] {
  const res = spawnSync("git", ["branch", "--list", "--format=%(refname:short)"], {
    cwd: repoPath,
    encoding: "utf8",
  });
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readPublishLintConfig(
  repoPath: string,
): { readonly publish_lint?: { readonly allowed_commands?: readonly string[] } } {
  const cfgPath = path.join(repoPath, ".samo", "config.json");
  if (!existsSync(cfgPath)) return {};
  try {
    const raw = readFileSync(cfgPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as { publish_lint?: { allowed_commands?: readonly string[] } };
  } catch {
    return {};
  }
}

/**
 * Real publish lint wired for use by `samospec publish`.
 *
 * Adapts the real `publishLint(spec, repoState)` signature into the
 * `PublishLint` callback shape `(opts) => PublishLintReport` so that
 * existing callers need no changes beyond switching their default from
 * the stub to this adapter.
 */
export const publishLintReal: PublishLint = (opts) => {
  const branches = localBranches(opts.repoPath);
  const config = readPublishLintConfig(opts.repoPath);
  const report = publishLint(opts.specBody, {
    repoRoot: opts.repoPath,
    branches,
    protectedBranches: ["main", "master", "develop", "trunk"],
    adapterModels: [],
    config,
  });
  return {
    hardWarnings: report.hardWarnings.map(findingToStub),
    softWarnings: report.softWarnings.map(findingToStub),
  };
};
