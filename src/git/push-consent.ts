// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §8 — first-push consent flow.
 *
 * Contract:
 *   - The first time samospec would push in a repo, `requestPushConsent`
 *     surfaces a prompt with remote name, remote URL, target branch,
 *     default branch, and PR-creation capability.
 *   - User answers `accept` / `refuse` → persisted to
 *     `.samospec/config.json` under `git.push_consent.<remote-url>`.
 *     Key is the remote URL (not name) so two remotes sharing a name on
 *     different URLs get distinct decisions.
 *   - Ctrl-C at the prompt surfaces as `interrupt` → exit 3 (SPEC §10).
 *   - On subsequent sessions the persisted choice is honored silently
 *     without re-prompting.
 *   - Consent `refuse` is NOT exit 5 (exit 5 is reserved for preflight
 *     cost refusal per SPEC §10). The session continues local-only.
 *
 * This module only handles consent and persistence — the actual
 * `git push` invocation lives in src/git/push.ts.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

// ---------- types ----------

export type PushConsentDecision = "accept" | "refuse" | "interrupt";

export interface PrCapabilityProbe {
  readonly available: boolean;
  /** `gh` when GitHub is authenticated, `glab` when GitLab. */
  readonly tool?: "gh" | "glab";
}

export interface PushConsentPrompt {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly targetBranch: string;
  readonly defaultBranch: string;
  readonly prCapability: PrCapabilityProbe;
}

export type PushConsentPromptFn = (
  prompt: PushConsentPrompt,
) => Promise<PushConsentDecision>;

export interface RequestPushConsentOpts {
  readonly repoPath: string;
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly targetBranch: string;
  readonly defaultBranch: string;
  readonly prCapability: PrCapabilityProbe;
  readonly prompt: PushConsentPromptFn;
}

export interface PushConsentOutcome {
  readonly decision: PushConsentDecision;
  /** Truthy when this invocation just wrote to .samospec/config.json. */
  readonly persisted: boolean;
  /** Exit code on `interrupt` (SPEC §10: 3). Undefined otherwise. */
  readonly exitCode?: number;
}

// ---------- persistence helpers ----------

export interface PersistConsentOpts {
  readonly repoPath: string;
  readonly remoteUrl: string;
  readonly granted: boolean;
}

export interface LoadConsentOpts {
  readonly repoPath: string;
  readonly remoteUrl: string;
}

export interface ClearConsentOpts {
  readonly repoPath: string;
  readonly remoteUrl: string;
}

/**
 * Return the persisted consent for a remote URL:
 *   - `true`  → granted
 *   - `false` → refused
 *   - `null`  → not yet decided (prompt on first push)
 *
 * Throws if `.samospec/config.json` is present but malformed — we refuse
 * to silently pass through when user configuration is corrupt.
 */
export function loadPersistedConsent(opts: LoadConsentOpts): boolean | null {
  const cfg = readConfig(opts.repoPath);
  if (cfg === null) return null;
  const push = extractPushConsent(cfg);
  const value = push[opts.remoteUrl];
  if (value === undefined) return null;
  if (typeof value !== "boolean") {
    throw new Error(
      `.samospec/config.json: git.push_consent[${JSON.stringify(
        opts.remoteUrl,
      )}] must be a boolean (got ${typeof value}).`,
    );
  }
  return value;
}

/**
 * Persist `granted` as `git.push_consent.<remote-url>` in config.json.
 * Creates the `.samospec/config.json` file if missing (keeps a schema_version
 * so a later `samospec init` merges defaults without surprise).
 */
export function persistConsent(opts: PersistConsentOpts): void {
  mutateConsent(opts.repoPath, (push) => {
    push[opts.remoteUrl] = opts.granted;
  });
}

/** Remove the stored consent for a remote URL. */
export function clearPersistedConsent(opts: ClearConsentOpts): void {
  mutateConsent(opts.repoPath, (push) => {
    delete push[opts.remoteUrl];
  });
}

// ---------- core request flow ----------

export async function requestPushConsent(
  opts: RequestPushConsentOpts,
): Promise<PushConsentOutcome> {
  const persisted = loadPersistedConsent({
    repoPath: opts.repoPath,
    remoteUrl: opts.remoteUrl,
  });
  if (persisted === true) {
    return { decision: "accept", persisted: false };
  }
  if (persisted === false) {
    return { decision: "refuse", persisted: false };
  }

  const decision = await opts.prompt({
    remoteName: opts.remoteName,
    remoteUrl: opts.remoteUrl,
    targetBranch: opts.targetBranch,
    defaultBranch: opts.defaultBranch,
    prCapability: opts.prCapability,
  });

  if (decision === "interrupt") {
    return { decision, persisted: false, exitCode: 3 };
  }

  persistConsent({
    repoPath: opts.repoPath,
    remoteUrl: opts.remoteUrl,
    granted: decision === "accept",
  });
  return { decision, persisted: true };
}

// ---------- PR-capability probe ----------

export interface PrCapabilityRunner {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProbePrCapabilityOpts {
  readonly gh?: () => PrCapabilityRunner;
  readonly glab?: () => PrCapabilityRunner;
}

/**
 * Detect whether a PR-creation tool is authenticated on this host.
 * Informational: the prompt surfaces it, never blocks on it. `gh` takes
 * precedence when both are authenticated (v1 targets GitHub primarily).
 *
 * Tests inject stub runners; the default production runners exec
 * `gh auth status` / `glab auth status` with silenced stdin.
 */
export function probePrCapability(
  opts: ProbePrCapabilityOpts = {},
): PrCapabilityProbe {
  const ghRun = opts.gh ?? defaultGhProbe;
  const glabRun = opts.glab ?? defaultGlabProbe;

  const ghResult = safeRun(ghRun);
  if (ghResult?.status === 0) {
    return { available: true, tool: "gh" };
  }
  const glabResult = safeRun(glabRun);
  if (glabResult?.status === 0) {
    return { available: true, tool: "glab" };
  }
  return { available: false };
}

function defaultGhProbe(): PrCapabilityRunner {
  const res = spawnSync("gh", ["auth", "status"], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function defaultGlabProbe(): PrCapabilityRunner {
  const res = spawnSync("glab", ["auth", "status"], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function safeRun(
  run: () => PrCapabilityRunner,
): PrCapabilityRunner | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}

// ---------- helpers to describe capability ----------

/**
 * Render a single-line human summary of PR capability suitable for the
 * consent prompt. Kept module-local so CLI callers share the phrasing.
 */
export function describePrCapability(probe: PrCapabilityProbe): string {
  if (!probe.available) return "PR creation unavailable (no gh/glab auth).";
  if (probe.tool === "gh") return "PR creation available via gh.";
  if (probe.tool === "glab") return "PR creation available via glab.";
  return "PR creation available.";
}

// ---------- internal helpers ----------

type JsonObject = Record<string, unknown>;

const CONFIG_REL = path.join(".samospec", "config.json");

function configPath(repoPath: string): string {
  return path.join(repoPath, CONFIG_REL);
}

function readConfig(repoPath: string): JsonObject | null {
  const file = configPath(repoPath);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `.samospec/config.json is not valid JSON: ${(err as Error).message}`,
      { cause: err },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`.samospec/config.json: top-level must be a JSON object.`);
  }
  return parsed as JsonObject;
}

function extractPushConsent(cfg: JsonObject): Record<string, unknown> {
  const git = cfg["git"];
  if (typeof git !== "object" || git === null || Array.isArray(git)) {
    return {};
  }
  const push = (git as JsonObject)["push_consent"];
  if (typeof push !== "object" || push === null || Array.isArray(push)) {
    return {};
  }
  return push as Record<string, unknown>;
}

function mutateConsent(
  repoPath: string,
  mutator: (push: Record<string, boolean>) => void,
): void {
  const file = configPath(repoPath);
  let cfg: JsonObject;
  if (existsSync(file)) {
    const existing = readConfig(repoPath);
    cfg = existing ?? {};
  } else {
    cfg = { schema_version: 1 };
  }

  let gitBlock: JsonObject;
  const existingGit = cfg["git"];
  if (
    typeof existingGit === "object" &&
    existingGit !== null &&
    !Array.isArray(existingGit)
  ) {
    gitBlock = existingGit as JsonObject;
  } else {
    gitBlock = {};
    cfg["git"] = gitBlock;
  }

  let push: Record<string, boolean>;
  const existingPush = gitBlock["push_consent"];
  if (
    typeof existingPush === "object" &&
    existingPush !== null &&
    !Array.isArray(existingPush)
  ) {
    push = existingPush as Record<string, boolean>;
  } else {
    push = {};
    gitBlock["push_consent"] = push;
  }

  mutator(push);

  cfg["git"] = gitBlock;
  atomicWriteJson(file, cfg);
}

function atomicWriteJson(file: string, body: JsonObject): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp.${process.pid}`);
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, payload, 0, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* platform-specific */
  }
}
