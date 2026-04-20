// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §14 — publish-lint seam (stub for Issue #32).
 *
 * Issue #33 will implement the actual lint rules (paths, commands,
 * branch names, adapter/model names). This module exports:
 *
 *   - `PublishLintReport` — the shape every lint implementation must
 *     return, so callers (including `samospec publish` and any future
 *     dogfood scorecard) can render findings uniformly.
 *   - `publishLintStub` — a no-op implementation that returns empty
 *     hard + soft warnings. Wiring `samospec publish` against the stub
 *     lets us ship the publish flow independently of #33.
 *
 * Scope guard (per Issue #32): do NOT implement real lint rules here.
 */

export interface PublishLintFinding {
  /** Short machine-readable id, e.g. `unknown-path`. */
  readonly id: string;
  /** Human-readable message surfaced in the PR body. */
  readonly message: string;
}

export interface PublishLintReport {
  /** Surfaced prominently in the PR body. Non-blocking per SPEC §14. */
  readonly hardWarnings: readonly PublishLintFinding[];
  /** Surfaced in a collapsible `<details>` section. */
  readonly softWarnings: readonly PublishLintFinding[];
}

export interface PublishLintOpts {
  /** Raw SPEC.md body. Rules in #33 will parse this. */
  readonly specBody: string;
  /** Absolute repo root. Path checks resolve under this. */
  readonly repoPath: string;
  /** Spec slug — used to scope branch-name checks in #33. */
  readonly slug: string;
}

export type PublishLint = (opts: PublishLintOpts) => PublishLintReport;

/**
 * Default lint seam: returns an empty report. Replaced by Issue #33.
 * Kept deterministic so tests can rely on it.
 */
export const publishLintStub: PublishLint = () => ({
  hardWarnings: [],
  softWarnings: [],
});
