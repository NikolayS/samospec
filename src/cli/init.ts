// Copyright 2026 Nikolay Samokhvalov.

/**
 * `samospec init` — create or merge a `.samospec/` config directory for
 * the current repo. SPEC §5 Phase 1, §10 (idempotent), §11 (pinned
 * defaults + budget), §14 (remote_probe off by default).
 *
 * Contract:
 *   - fresh dir    -> write default config + .gitignore + cache skeleton; exit 0
 *   - existing dir -> merge user keys with defaults; print diff; exit 0
 *   - malformed    -> exit 1 with a clear error; do NOT silently overwrite
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CONFIG_SCHEMA_VERSION = 1 as const;

export interface LeadAdapterDefaults {
  readonly adapter: "claude";
  readonly model_id: "claude-opus-4-7";
  readonly effort: "max";
  readonly fallback_chain: readonly string[];
}

export interface ReviewerAAdapterDefaults {
  readonly adapter: "codex";
  readonly model_id: "gpt-5.1-codex-max";
  readonly effort: "high";
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
 * - Reviewer A: codex / gpt-5.1-codex-max / high
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
      model_id: "gpt-5.1-codex-max",
      effort: "high",
      fallback_chain: ["gpt-5.1-codex-max", "gpt-5.1-codex", "terminal"],
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

export function runInit(args: RunInitArgs): RunInitResult {
  const samoDir = path.join(args.cwd, ".samospec");
  const configPath = path.join(samoDir, "config.json");
  const gitignorePath = path.join(samoDir, ".gitignore");
  const cacheDir = path.join(samoDir, "cache");
  const gistsDir = path.join(cacheDir, "gists");

  const messages: string[] = [];

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
          `samospec: failed to read existing .samospec/config.json: ` +
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
            `samospec: existing .samospec/config.json is malformed: ` +
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
          `samospec: existing .samospec/config.json is malformed JSON: ` +
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
    messages.push(`created .samospec/.gitignore`);
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
    messages.push(`created .samospec/config.json`);
  } else if (diff.length > 0) {
    writeFileSync(configPath, mergedJson, "utf8");
    wroteConfig = true;
    messages.push(`merged .samospec/config.json:`);
    for (const line of diff) messages.push(`  ${line}`);
  }

  if (!wroteConfig && messages.length === 0) {
    messages.push(`samospec: .samospec/ is up to date — no changes.`);
  } else if (existedBefore && diff.length === 0) {
    messages.push(`samospec: config.json unchanged.`);
  }

  if (!existedBefore) {
    messages.unshift(`samospec: initialized .samospec/ in ${args.cwd}`);
  }

  const stdout = `${messages.join("\n")}\n`;
  return { exitCode: 0, stdout, stderr: "" };
}
