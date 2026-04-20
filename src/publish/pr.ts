// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §5 Phase 7 + §10 — PR opening via `gh` / `glab` with a
 * compare-URL fallback.
 *
 * Contract:
 *   - When `capability.tool === "gh"` (probed via
 *     src/git/push-consent.ts `probePrCapability`), invoke
 *     `gh pr create --title ... --body-file ... --base ... --head ...`.
 *   - When `capability.tool === "glab"`, invoke
 *     `glab mr create --title ... --description-file ... ...` (glab
 *     uses `--description` for the body; we pass the file via the
 *     `-F`-equivalent long flag below).
 *   - When `capability.available === false`, return the compare URL so
 *     the caller can print it.
 *
 * Tests inject stub runners; the default production runner execs the
 * chosen tool with silenced stdin. No `GIT_TERMINAL_PROMPT` games
 * because `gh` / `glab` have their own credential flows — but we still
 * propagate the invocation's env so PATH-shimmed test scripts work.
 */

import { spawnSync } from "node:child_process";

import type { PrCapabilityProbe } from "../git/push-consent.ts";

export interface PrRunnerResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type PrRunner = (argv: readonly string[]) => PrRunnerResult;

export interface OpenPrOpts {
  readonly capability: PrCapabilityProbe;
  readonly title: string;
  readonly bodyFile: string;
  readonly branch: string;
  readonly defaultBranch: string;
  readonly remoteUrl: string;
  /** Override PATH / cwd for subprocess execs. */
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** Injection seams — tests pass fake runners. */
  readonly gh?: PrRunner;
  readonly glab?: PrRunner;
}

export type OpenPrResult =
  | {
      readonly kind: "opened";
      readonly tool: "gh" | "glab";
      /** Parsed PR URL from the tool's stdout, when available. */
      readonly url?: string;
    }
  | {
      readonly kind: "compare-url";
      readonly url: string;
    }
  | {
      readonly kind: "failed";
      readonly tool: "gh" | "glab";
      readonly message: string;
    }
  | {
      readonly kind: "no-compare-url";
      readonly reason: string;
    };

export function openPullRequest(opts: OpenPrOpts): OpenPrResult {
  const compareUrl = buildCompareUrl({
    remoteUrl: opts.remoteUrl,
    defaultBranch: opts.defaultBranch,
    branch: opts.branch,
  });

  if (!opts.capability.available) {
    if (compareUrl === null) {
      return {
        kind: "no-compare-url",
        reason:
          `Cannot derive a compare URL for remote '${opts.remoteUrl}'. ` +
          `Open a PR manually from branch '${opts.branch}' → '${opts.defaultBranch}'.`,
      };
    }
    return { kind: "compare-url", url: compareUrl };
  }

  // gh preferred when both are authenticated (probe enforces this).
  if (opts.capability.tool === "gh") {
    const run = opts.gh ?? defaultGhRunner(opts);
    const res = run([
      "pr",
      "create",
      "--title",
      opts.title,
      "--body-file",
      opts.bodyFile,
      "--base",
      opts.defaultBranch,
      "--head",
      opts.branch,
    ]);
    if (res.status !== 0) {
      return {
        kind: "failed",
        tool: "gh",
        message: (res.stderr ?? "").trim() || (res.stdout ?? "").trim(),
      };
    }
    const url = extractFirstUrl(res.stdout);
    return url !== null
      ? { kind: "opened", tool: "gh", url }
      : { kind: "opened", tool: "gh" };
  }

  if (opts.capability.tool === "glab") {
    const run = opts.glab ?? defaultGlabRunner(opts);
    const res = run([
      "mr",
      "create",
      "--title",
      opts.title,
      "--description-file",
      opts.bodyFile,
      "--target-branch",
      opts.defaultBranch,
      "--source-branch",
      opts.branch,
      "--yes",
    ]);
    if (res.status !== 0) {
      return {
        kind: "failed",
        tool: "glab",
        message: (res.stderr ?? "").trim() || (res.stdout ?? "").trim(),
      };
    }
    const url = extractFirstUrl(res.stdout);
    return url !== null
      ? { kind: "opened", tool: "glab", url }
      : { kind: "opened", tool: "glab" };
  }

  if (compareUrl === null) {
    return {
      kind: "no-compare-url",
      reason: `Unknown capability tool and no compare URL derivable.`,
    };
  }
  return { kind: "compare-url", url: compareUrl };
}

function defaultGhRunner(opts: OpenPrOpts): PrRunner {
  return (argv) => {
    const res = spawnSync("gh", argv as string[], {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        ...(opts.env ?? {}),
      },
    });
    return {
      status: res.status ?? 1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
    };
  };
}

function defaultGlabRunner(opts: OpenPrOpts): PrRunner {
  return (argv) => {
    const res = spawnSync("glab", argv as string[], {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        ...(opts.env ?? {}),
      },
    });
    return {
      status: res.status ?? 1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
    };
  };
}

function extractFirstUrl(stdout: string): string | null {
  const match = /https?:\/\/\S+/.exec(stdout);
  return match === null ? null : match[0];
}

// ---------- compare URL derivation ----------

export interface CompareUrlOpts {
  readonly remoteUrl: string;
  readonly defaultBranch: string;
  readonly branch: string;
}

/**
 * Derive a web-compare URL from a GitHub/GitLab remote URL. Returns
 * `null` for unrecognized hosts. Handles both `git@host:owner/repo.git`
 * and `https://host/owner/repo.git` shapes.
 */
export function buildCompareUrl(opts: CompareUrlOpts): string | null {
  const parsed = parseRemote(opts.remoteUrl);
  if (parsed === null) return null;

  if (parsed.host.endsWith("github.com")) {
    return (
      `https://${parsed.host}/${parsed.owner}/${parsed.repo}/compare/` +
      `${opts.defaultBranch}...${opts.branch}`
    );
  }
  if (parsed.host.endsWith("gitlab.com")) {
    // GitLab's "new MR" URL carries the source + target via query params.
    return (
      `https://${parsed.host}/${parsed.owner}/${parsed.repo}/-/merge_requests/new` +
      `?merge_request[source_branch]=${opts.branch}` +
      `&merge_request[target_branch]=${opts.defaultBranch}`
    );
  }
  return null;
}

interface ParsedRemote {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

function parseRemote(url: string): ParsedRemote | null {
  // ssh form: git@host:owner/repo(.git)?
  const ssh = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (ssh !== null) {
    const host = ssh[1];
    const owner = ssh[2];
    const repo = ssh[3];
    if (host !== undefined && owner !== undefined && repo !== undefined) {
      return { host, owner, repo };
    }
  }
  // https form: https://host/owner/repo(.git)?
  const https = /^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  if (https !== null) {
    const host = https[1];
    const owner = https[2];
    const repo = https[3];
    if (host !== undefined && owner !== undefined && repo !== undefined) {
      return { host, owner, repo };
    }
  }
  return null;
}
