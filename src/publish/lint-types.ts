// Copyright 2026 Nikolay Samokhvalov.

/**
 * Public types for `src/publish/lint.ts`. SPEC §14 "Hallucinated repo
 * facts (publish lint, broadened)" defines two severity tiers:
 *
 * - **Hard warnings** — definitely wrong (missing file paths).
 * - **Soft warnings** — heuristic (unknown commands, ghost branches,
 *   adapter/model drift).
 *
 * `RepoState` is the read-only snapshot the lint uses to decide what is
 * "real" — file system for paths, local branch list for branches,
 * resolved adapter models from `state.json`, user config for the
 * command allowlist.
 */

/** Source position inside the spec string (1-indexed line). */
export interface LintLocation {
  readonly line: number;
}

/** Fixed set of finding kinds. Used by tooling to classify outputs. */
export type LintFindingKind =
  | "missing-path"
  | "unknown-command"
  | "ghost-branch"
  | "adapter-drift";

export interface LintFinding {
  readonly kind: LintFindingKind;
  readonly message: string;
  readonly location?: LintLocation;
}

export interface PublishLintReport {
  readonly hardWarnings: readonly LintFinding[];
  readonly softWarnings: readonly LintFinding[];
}

/**
 * User-config subset read by the lint. Mirrors the shape `init.ts`
 * writes to `.samospec/config.json` — a `publish_lint.allowed_commands`
 * array layers on top of the hardcoded allowlist. Other unrelated
 * config keys are ignored.
 */
export interface PublishLintConfig {
  readonly publish_lint?: {
    readonly allowed_commands?: readonly string[];
  };
}

/**
 * Read-only snapshot of repo facts used to decide what is "real".
 *
 * - `repoRoot` — absolute path used to resolve extracted paths.
 * - `branches` — local branch list (from `git branch --list` or a mock).
 * - `protectedBranches` — combined hardcoded + user-config list; any
 *   branch name matching this list is never a ghost.
 * - `adapterModels` — resolved model ids from `state.json` (lead +
 *   reviewer_a + reviewer_b). Drift checks compare `claude-…` /
 *   `gpt-…` tokens in prose against this list.
 * - `config` — parsed `.samospec/config.json` content subset.
 */
export interface RepoState {
  readonly repoRoot: string;
  readonly branches: readonly string[];
  readonly protectedBranches: readonly string[];
  readonly adapterModels: readonly string[];
  readonly config: PublishLintConfig;
}
