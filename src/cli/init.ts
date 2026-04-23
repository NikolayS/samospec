// Copyright 2026 Nikolay Samokhvalov.

/**
 * `samospec init` — create or merge a `.samo/` config directory for
 * the current repo. SPEC §5 Phase 1, §10 (idempotent), §11 (pinned
 * defaults + budget), §14 (remote_probe off by default).
 *
 * Contract:
 *   - fresh dir    -> write default config + .gitignore + cache skeleton; exit 0
 *   - existing dir -> merge user keys with defaults; print diff; exit 0
 *   - malformed    -> exit 1 with a clear error; do NOT silently overwrite
 *
 * Git preflight (#72 / #65):
 *   - No .git dir + --yes/non-interactive: auto git-init + empty commit.
 *   - No .git dir + interactive: prompt [I]nit/[A]bort [Enter=init].
 *     'A' -> exit 3, nothing written.
 *   - .git present but no HEAD: auto-create initial empty commit (always
 *     safe, no prompt needed).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const CONFIG_SCHEMA_VERSION = 1 as const;

export interface LeadAdapterDefaults {
  readonly adapter: "claude";
  readonly model_id: "claude-opus-4-7";
  readonly effort: "max";
  readonly fallback_chain: readonly string[];
}

export interface ReviewerAAdapterDefaults {
  readonly adapter: "codex";
  readonly model_id: "gpt-5.4";
  readonly effort: "max";
  readonly fallback_chain: readonly string[];
}

export interface ReviewerBAdapterDefaults {
  readonly adapter: "claude";
  readonly model_id: "claude-opus-4-7";
  readonly effort: "max";
  readonly fallback_chain: readonly string[];
}

export interface BudgetDefaults {
  readonly max_iterations: number;
  readonly max_reviewers: number;
  readonly max_tokens_per_round: number;
  readonly max_total_tokens_per_session: number;
  readonly max_wall_clock_minutes: number;
  readonly preflight_confirm_usd: number;
}

export interface GitDefaults {
  readonly remote_probe: boolean;
  readonly protected_branches: readonly string[];
  /**
   * SPEC §8 — `git fetch` timeout during `samospec resume` remote
   * reconciliation. On timeout / failure, the caller flips
   * `state.json.remote_stale = true` and continues local-only.
   */
  readonly fetch_timeout_seconds: number;
}

export interface ContextDefaults {
  readonly injection_threshold: number;
}

export interface ConvergenceDefaults {
  readonly min_delta_lines: number;
}

/**
 * Sprint 4 #33 — publish lint. The `allowed_commands` array is additive
 * (user entries layer on top of the hardcoded allowlist in
 * `src/publish/lint.ts`). Defaults to empty so the hardcoded list is the
 * baseline; users extend for custom shell helpers.
 */
export interface PublishLintDefaults {
  readonly allowed_commands: readonly string[];
}

export interface DefaultConfig {
  readonly schema_version: typeof CONFIG_SCHEMA_VERSION;
  readonly adapters: {
    readonly lead: LeadAdapterDefaults;
    readonly reviewer_a: ReviewerAAdapterDefaults;
    readonly reviewer_b: ReviewerBAdapterDefaults;
  };
  readonly budget: BudgetDefaults;
  readonly git: GitDefaults;
  readonly context: ContextDefaults;
  readonly convergence: ConvergenceDefaults;
  readonly publish_lint: PublishLintDefaults;
}

/**
 * Pinned v1 defaults. SPEC §11.
 * - Lead: claude / claude-opus-4-7 / max
 * - Reviewer A: codex / gpt-5.4 / max (xhigh reasoning effort)
 * - Reviewer B: claude / claude-opus-4-7 / max (same family as lead)
 * - Budget: generous defaults (SPEC §11 Budget guardrails).
 * - Git: remote_probe off by default (SPEC §14 threat model).
 */
export const DEFAULT_CONFIG: DefaultConfig = {
  schema_version: CONFIG_SCHEMA_VERSION,
  adapters: {
    lead: {
      adapter: "claude",
      model_id: "claude-opus-4-7",
      effort: "max",
      fallback_chain: ["claude-opus-4-7", "claude-sonnet-4-6", "terminal"],
    },
    reviewer_a: {
      adapter: "codex",
      model_id: "gpt-5.4",
      effort: "max",
      fallback_chain: ["gpt-5.4", "gpt-5.3-codex", "terminal"],
    },
    reviewer_b: {
      adapter: "claude",
      model_id: "claude-opus-4-7",
      effort: "max",
      fallback_chain: ["claude-opus-4-7", "claude-sonnet-4-6", "terminal"],
    },
  },
  budget: {
    max_iterations: 10,
    max_reviewers: 2,
    max_tokens_per_round: 250_000,
    max_total_tokens_per_session: 2_000_000,
    max_wall_clock_minutes: 240,
    preflight_confirm_usd: 20,
  },
  git: {
    remote_probe: false,
    protected_branches: [],
    fetch_timeout_seconds: 5,
  },
  context: {
    injection_threshold: 5,
  },
  convergence: {
    min_delta_lines: 20,
  },
  publish_lint: {
    allowed_commands: [],
  },
};

const GITIGNORE_BODY = [
  "# samospec — local-only files (SPEC §9)",
  "transcripts/",
  "cache/",
  ".lock",
  "",
].join("\n");

export interface RunInitArgs {
  readonly cwd: string;
  /**
   * Skip the interactive git-init prompt and auto-init (#72).
   * Set `true` when the caller passes `--yes` or `--no-interactive`.
   */
  readonly yes?: boolean;
  /**
   * Test seam: inject the answer for the interactive git-init prompt
   * instead of reading from stdin. "I" or "" = init; "A" = abort.
   */
  readonly gitInitAnswer?: string;
}

export interface RunInitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

type JsonObject = Record<string, unknown>;

/**
 * Deep-merge `base` into `user`: every key present in `base` but missing
 * in `user` is filled in; keys the user set are preserved verbatim
 * (never overwritten). Arrays are treated as opaque values — user arrays
 * are kept as-is. Tracks the paths that were added.
 */
function mergeDefaults(
  user: JsonObject,
  base: JsonObject,
  trail: string,
  diff: string[],
): JsonObject {
  const out: JsonObject = { ...user };
  for (const [key, baseVal] of Object.entries(base)) {
    const here = trail === "" ? key : `${trail}.${key}`;
    const userVal = out[key];
    if (userVal === undefined) {
      out[key] = baseVal;
      diff.push(`added   ${here} = ${formatValue(baseVal)}`);
      continue;
    }
    if (isPlainObject(userVal) && isPlainObject(baseVal)) {
      out[key] = mergeDefaults(userVal, baseVal, here, diff);
    }
    // Else: preserve user value (includes arrays, primitives, or type-mismatch).
  }
  return out;
}

function isPlainObject(v: unknown): v is JsonObject {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

function formatValue(v: unknown): string {
  if (isPlainObject(v)) return "{...}";
  if (Array.isArray(v)) return "[...]";
  return JSON.stringify(v);
}

// ---------- git preflight helpers (#72 / #65) ----------

/**
 * Run a git command in `cwd`. Returns status + stdout + stderr.
 * Never throws — callers inspect `.status`.
 */
function runGitCmd(
  cwd: string,
  args: readonly string[],
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("git", args as string[], {
    cwd,
    encoding: "utf8",
    env: { ...process.env },
  });
  return {
    status: res.status ?? 1,
    stdout: (res.stdout as string | null) ?? "",
    stderr: (res.stderr as string | null) ?? "",
  };
}

/** Returns true when `cwd/.git` exists (not necessarily with any commits). */
function hasGitDir(cwd: string): boolean {
  return existsSync(path.join(cwd, ".git"));
}

/** Returns true when HEAD resolves (i.e. at least one commit exists). */
function hasHead(cwd: string): boolean {
  return runGitCmd(cwd, ["rev-parse", "HEAD"]).status === 0;
}

/**
 * Ensure a minimal git identity is configured locally so that
 * `git commit` won't fail on CI or bare environments.
 * Falls back to samospec defaults only when the key is absent globally.
 */
function ensureGitIdentity(cwd: string): void {
  // Check whether a name/email exist (global or local).
  const nameOk = runGitCmd(cwd, ["config", "user.name"]).status === 0;
  const emailOk = runGitCmd(cwd, ["config", "user.email"]).status === 0;
  if (!nameOk) {
    runGitCmd(cwd, ["config", "--local", "user.name", "samospec"]);
  }
  if (!emailOk) {
    runGitCmd(cwd, ["config", "--local", "user.email", "samospec@localhost"]);
  }
  // Disable GPG signing locally to avoid passphrase prompts in CI.
  runGitCmd(cwd, ["config", "--local", "commit.gpgsign", "false"]);
}

/**
 * Create an empty initial commit with message `chore: init`.
 * Ensures a local git identity is configured first (CI / bare env).
 * Returns the error string on failure, or null on success.
 */
function createInitialCommit(cwd: string): string | null {
  ensureGitIdentity(cwd);
  const commit = runGitCmd(cwd, [
    "commit",
    "--allow-empty",
    "-m",
    "chore: init",
  ]);
  if (commit.status !== 0) {
    return commit.stderr.trim() || "git commit failed";
  }
  return null;
}

/**
 * Run `git init` and create an empty initial commit.
 * Returns an error string on failure, or null on success.
 */
function initGitRepo(cwd: string): string | null {
  const init = runGitCmd(cwd, ["init", cwd]);
  if (init.status !== 0) {
    return init.stderr.trim() || "git init failed";
  }
  return createInitialCommit(cwd);
}

/**
 * Determine whether to proceed with git init.
 * Returns `true` to init, `false` to abort, or `null` when the caller
 * has not opted in to the git preflight (no --yes and no injected answer).
 *
 * - `args.yes === true`: non-interactive auto-init.
 * - `args.gitInitAnswer` set: test-seam answer ("I"/"" → init, "A" → abort).
 * - Neither set: git preflight is skipped entirely (legacy / library call).
 */
function resolveGitInitDecision(args: RunInitArgs): boolean | null {
  // Non-interactive: --yes flag.
  if (args.yes === true) return true;

  // Test seam: caller injected an answer.
  if (args.gitInitAnswer !== undefined) {
    const answer = args.gitInitAnswer.trim().toUpperCase();
    // Empty string or "I" → init (default). Anything else → abort.
    return answer !== "A";
  }

  // Neither flag set — skip the git preflight (backward-compatible).
  return null;
}

// ---------- main entry point ----------

export function runInit(args: RunInitArgs): RunInitResult {
  const samoDir = path.join(args.cwd, ".samo");
  const configPath = path.join(samoDir, "config.json");
  const gitignorePath = path.join(samoDir, ".gitignore");
  const cacheDir = path.join(samoDir, "cache");
  const gistsDir = path.join(cacheDir, "gists");

  const messages: string[] = [];

  // ---- git preflight (#72 / #65) ----
  //
  // Only active when the caller opts in via `yes: true` or `gitInitAnswer`.
  // This keeps the function backward-compatible for callers that don't need
  // the git-init dance (e.g. existing tests that set up `.samo/` directly).

  if (!hasGitDir(args.cwd)) {
    // No .git at all — maybe offer to initialize (#72).
    const decision = resolveGitInitDecision(args);
    if (decision === null) {
      // Caller did not opt in to the git preflight — skip silently.
    } else if (!decision) {
      // User chose to abort (interactive "A").
      return {
        exitCode: 3,
        stdout: "",
        stderr: "samospec: aborted — no git repo initialized.\n",
      };
    } else {
      // decision === true: proceed with git init.
      const err = initGitRepo(args.cwd);
      if (err !== null) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `samospec: git init failed: ${err}\n`,
        };
      }
      messages.push("created git repo and initial commit (chore: init)");
    }
  } else if (
    hasGitDir(args.cwd) &&
    !hasHead(args.cwd) &&
    resolveGitInitDecision(args) !== null
  ) {
    // .git exists but no commits yet (#65 — empty repo).
    // Only triggered when the caller opts in (yes: true or gitInitAnswer).
    // When neither is set (legacy / library call), skip — `runNew`'s
    // ensureHasCommit handles this path for the `new` command.
    const err = createInitialCommit(args.cwd);
    if (err !== null) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: `samospec: failed to create initial commit: ${err}\n`,
      };
    }
    messages.push("no commits found — created initial commit (chore: init)");
  }

  // Is there already a config.json to merge against?
  const existedBefore = existsSync(configPath);
  let userConfig: JsonObject = {};
  if (existedBefore) {
    let raw: string;
    try {
      raw = readFileSync(configPath, "utf8");
    } catch (err) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          `samospec: failed to read existing .samo/config.json: ` +
          `${(err as Error).message}\n`,
      };
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isPlainObject(parsed)) {
        return {
          exitCode: 1,
          stdout: "",
          stderr:
            `samospec: existing .samo/config.json is malformed: ` +
            `top-level value must be a JSON object. Fix or remove it ` +
            `and rerun samospec init.\n`,
        };
      }
      userConfig = parsed;
    } catch (err) {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          `samospec: existing .samo/config.json is malformed JSON: ` +
          `${(err as Error).message}\n` +
          `Fix or remove it and rerun samospec init. ` +
          `(Refusing to silently overwrite user configuration.)\n`,
      };
    }
  }

  // Create directory structure first. Parents are mkdir -p idempotent.
  mkdirSync(samoDir, { recursive: true });
  mkdirSync(gistsDir, { recursive: true });

  // .gitignore: write if missing; never modify a user-edited one.
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, GITIGNORE_BODY, "utf8");
    messages.push(`created .samo/.gitignore`);
  }

  // Merge defaults → user config.
  const diff: string[] = [];
  const merged = mergeDefaults(
    userConfig,
    DEFAULT_CONFIG as unknown as JsonObject,
    "",
    diff,
  );

  // Migration path: if the stored schema_version is older, upgrade.
  // Current version is 1 so this is a no-op; the hook is here intentionally.
  const storedVersion = merged["schema_version"];
  if (
    typeof storedVersion === "number" &&
    storedVersion !== CONFIG_SCHEMA_VERSION
  ) {
    merged["schema_version"] = CONFIG_SCHEMA_VERSION;
    diff.push(
      `migrated schema_version ${storedVersion} -> ${CONFIG_SCHEMA_VERSION}`,
    );
  }

  // Write the merged config only when it differs from what was on disk,
  // so a truly no-op re-run can advertise itself cleanly.
  const mergedJson = `${JSON.stringify(merged, null, 2)}\n`;
  let wroteConfig = false;
  if (!existedBefore) {
    writeFileSync(configPath, mergedJson, "utf8");
    wroteConfig = true;
    messages.push(`created .samo/config.json`);
  } else if (diff.length > 0) {
    writeFileSync(configPath, mergedJson, "utf8");
    wroteConfig = true;
    messages.push(`merged .samo/config.json:`);
    for (const line of diff) messages.push(`  ${line}`);
  }

  if (!wroteConfig && messages.length === 0) {
    messages.push(`samospec: .samo/ is up to date — no changes.`);
  } else if (existedBefore && diff.length === 0) {
    messages.push(`samospec: config.json unchanged.`);
  }

  if (!existedBefore) {
    messages.unshift(`samospec: initialized .samo/ in ${args.cwd}`);
  }

  const stdout = `${messages.join("\n")}\n`;
  return { exitCode: 0, stdout, stderr: "" };
}
