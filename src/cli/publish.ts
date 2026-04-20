// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §5 Phase 7 + §8 + §9 + §10 — `samospec publish`.
 *
 * Promotes the committed working SPEC.md to `blueprints/<slug>/SPEC.md`,
 * creates the publish commit on the current `samospec/<slug>` branch
 * (never a protected branch — safety invariant), pushes to the remote
 * if consent is granted, opens a PR via `gh` preferred over `glab`, and
 * records the advance in state.json.
 *
 * Flow:
 *   1. Preconditions (exit 1 on miss):
 *      - `.samo/spec/<slug>/state.json` exists.
 *      - `state.round_state === "committed"`.
 *      - `state.published_at` is absent (republish error message).
 *   2. Safety invariant: refuse if current branch is protected (exit 2).
 *   3. Copy SPEC.md → `blueprints/<slug>/SPEC.md`.
 *   4. Advance state: set `published_at`, `published_version`,
 *      `phase = "publish"` (§5 Phase 7), write via writeState.
 *   5. `specCommit` with action `publish`, version stripped to `X.Y` when
 *      the stored triple is `X.Y.0` (SPEC §8 grammar).
 *   6. Push per consent (existing #31 helpers).
 *   7. Open PR: compose body from TLDR + changelog + meta + lint seam.
 *   8. On PR open success: write the URL back into state.json.
 *
 * Scope guards:
 *   - NO lint rule implementation (Issue #33).
 *   - NO force push, no amend — the existing git helpers forbid it.
 *   - NO destructive ops.
 *
 * Exit codes (SPEC §10):
 *   - 0 success.
 *   - 1 preconditions (no spec / not committed / already published).
 *   - 2 push failure or protected-branch refusal.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { currentBranch } from "../git/branch.ts";
import { specCommit } from "../git/commit.ts";
import { ProtectedBranchError } from "../git/errors.ts";
import { isProtected } from "../git/protected.ts";
import {
  loadPersistedConsent,
  probePrCapability,
  type PrCapabilityProbe,
} from "../git/push-consent.ts";
import { pushBranch, type PushBranchResult } from "../git/push.ts";
import { formatVersionLabel } from "../loop/version.ts";
import { writeState } from "../state/store.ts";
import { stateSchema, type State } from "../state/types.ts";
import { specPaths } from "./new.ts";
import { buildPrBody } from "../publish/body.ts";
import { promoteSpecToBlueprint } from "../publish/blueprints.ts";
import {
  publishLintStub,
  type PublishLint,
  type PublishLintReport,
} from "../publish/lint-stub.ts";
import {
  buildCompareUrl,
  openPullRequest,
  type OpenPrResult,
} from "../publish/pr.ts";

export interface PublishInput {
  readonly cwd: string;
  readonly slug: string;
  readonly now: string;
  readonly remote: string;
  /** Override env forwarded to `gh` / `glab` — test shims use this. */
  readonly env?: NodeJS.ProcessEnv;
  /** `--no-lint` — skip the lint call entirely. */
  readonly noLint?: boolean;
  /** Lint injection seam. Defaults to the stub (Issue #33 replaces). */
  readonly lint?: PublishLint;
  /** PR-capability probe override — tests use a deterministic probe. */
  readonly probePrCapability?: () => PrCapabilityProbe;
}

export interface PublishResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function runPublish(input: PublishInput): Promise<PublishResult> {
  // NOTE: the body is synchronous today — all I/O is `fs` sync and
  // `spawnSync`. The function is typed `async` so the runCli dispatch
  // shape stays uniform with `runIterate` / `runNew` / etc., and so a
  // future push-consent prompt can slot in without a signature change.
  const outLines: string[] = [];
  const errLines: string[] = [];
  const notice = (s: string): void => {
    outLines.push(s);
  };
  const error = (s: string): void => {
    errLines.push(s);
  };

  const paths = specPaths(input.cwd, input.slug);

  // -- preconditions --
  if (!existsSync(paths.statePath)) {
    error(
      `samospec: no spec found for slug '${input.slug}'. ` +
        `Run \`samospec new ${input.slug}\` first.`,
    );
    return finish(1, outLines, errLines);
  }

  const stateParsed = stateSchema.safeParse(
    JSON.parse(readFileSync(paths.statePath, "utf8")) as unknown,
  );
  if (!stateParsed.success) {
    error(
      `samospec: state.json at ${paths.statePath} is malformed: ${stateParsed.error.message}`,
    );
    return finish(1, outLines, errLines);
  }
  const state: State = stateParsed.data;

  // Republish check (must come BEFORE the committed-state check so the
  // message is actionable: we don't want to confuse users who already
  // advanced past `committed` via publish).
  if (state.published_at !== undefined) {
    error(
      `samospec: '${input.slug}' is already published at ${state.published_at}. ` +
        `Use \`samospec iterate ${input.slug}\` to run more rounds, then republish.`,
    );
    return finish(1, outLines, errLines);
  }

  if (state.round_state !== "committed") {
    error(
      `samospec: '${input.slug}' is at round_state '${state.round_state}', ` +
        `expected 'committed'. Complete at least a v0.1 draft via ` +
        `\`samospec new ${input.slug}\` or \`samospec iterate ${input.slug}\` first.`,
    );
    return finish(1, outLines, errLines);
  }

  if (!existsSync(paths.specPath)) {
    error(
      `samospec: SPEC.md for '${input.slug}' is missing — run ` +
        `\`samospec resume ${input.slug}\` first.`,
    );
    return finish(1, outLines, errLines);
  }

  // -- safety invariant (SPEC §8 + Sprint 1 #3): refuse up-front on a
  // protected branch BEFORE mutating any files or state. This keeps
  // the filesystem unchanged if the user ran publish from the wrong
  // branch by accident.
  const preBranch = currentBranch(input.cwd);
  if (isProtected(preBranch, { repoPath: input.cwd })) {
    error(
      `samospec: cannot commit on protected branch '${preBranch}'. ` +
        `Check out samospec/${input.slug} and re-run.`,
    );
    return finish(2, outLines, errLines);
  }

  // -- promote blueprint --
  // SPEC §9: `blueprints/<slug>/SPEC.md` is a promoted snapshot; never
  // hand-edited. `promoteSpecToBlueprint` is idempotent.
  const blueprintPath = promoteSpecToBlueprint({
    cwd: input.cwd,
    slug: input.slug,
  });

  // -- advance state --
  const publishedVersion = formatVersionLabel(state.version); // `v0.2`
  const commitVersion = stripLeadingV(publishedVersion); // `0.2`
  const advancedState: State = {
    ...state,
    phase: "publish",
    published_at: input.now,
    published_version: publishedVersion,
    updated_at: input.now,
  };
  writeState(paths.statePath, advancedState);

  // -- commit on the samospec/<slug> branch --
  // specCommit refuses on protected branches (SPEC §8 safety invariant).
  try {
    specCommit({
      repoPath: input.cwd,
      slug: input.slug,
      action: "publish",
      version: commitVersion,
      paths: [
        path.relative(input.cwd, blueprintPath),
        path.relative(input.cwd, paths.statePath),
      ],
    });
    notice(`committed spec(${input.slug}): publish ${publishedVersion}.`);
  } catch (err) {
    if (err instanceof ProtectedBranchError) {
      error(
        `samospec: cannot commit on protected branch '${err.branchName}'. ` +
          `Check out samospec/${input.slug} and re-run.`,
      );
      return finish(2, outLines, errLines);
    }
    throw err;
  }

  // -- push --
  const branch = currentBranch(input.cwd);
  const remoteUrl = resolveRemoteUrl(input.cwd, input.remote);
  const defaultBranch = resolveDefaultBranch(input.cwd, input.remote);
  let pushResult: PushBranchResult | null = null;
  if (remoteUrl !== null) {
    const consent = loadPersistedConsent({
      repoPath: input.cwd,
      remoteUrl,
    });
    // Honor consent: accepted → push; refused or unresolved → skip.
    const granted = consent === true;
    pushResult = safePushBranch({
      repoPath: input.cwd,
      remote: input.remote,
      branch,
      granted,
      noPush: false,
    });
    switch (pushResult.state) {
      case "pushed":
        notice(`pushed to ${input.remote}.`);
        break;
      case "skipped-refused":
        error(
          `samospec: push skipped — consent refused. ` +
            `PR cannot be opened without remote push.`,
        );
        break;
      case "skipped-no-push":
        // Not reachable (noPush is always false here), kept for
        // exhaustiveness.
        break;
      case "failed":
        error(
          `samospec: push to ${input.remote} failed: ${pushResult.message ?? "(no detail)"}.`,
        );
        return finish(2, outLines, errLines);
    }
  }

  // -- compose PR body --
  // Read TLDR + changelog fresh (both committed by iterate / new).
  const tldr = existsSync(paths.tldrPath)
    ? readFileSync(paths.tldrPath, "utf8")
    : `# TL;DR\n\nSee SPEC.md.\n`;
  const changelog = existsSync(paths.changelogPath)
    ? readFileSync(paths.changelogPath, "utf8")
    : `# changelog\n`;

  // -- lint seam --
  let lintReport: PublishLintReport = { hardWarnings: [], softWarnings: [] };
  if (input.noLint !== true) {
    const lint: PublishLint = input.lint ?? publishLintStub;
    lintReport = lint({
      specBody: readFileSync(paths.specPath, "utf8"),
      repoPath: input.cwd,
      slug: input.slug,
    });
  }

  const degradedResolution = summarizeDegraded(state);
  const exitReason = state.exit?.reason ?? "committed";
  const body = buildPrBody({
    slug: input.slug,
    version: publishedVersion,
    tldr,
    changelog,
    roundCount: state.round_index,
    exitReason,
    degradedResolution,
    lintReport,
  });

  // -- PR open (or compare URL) --
  // Only attempt to open a PR when the push actually landed; otherwise
  // there is no source branch on the remote for gh/glab to target.
  let prResult: OpenPrResult | null = null;
  if (pushResult?.state === "pushed" && remoteUrl !== null) {
    const capability = (input.probePrCapability ?? defaultProbe(input))();
    const bodyFile = writeTempBody(body);
    try {
      prResult = openPullRequest({
        capability,
        title: `spec(${input.slug}): publish ${publishedVersion}`,
        bodyFile,
        branch,
        defaultBranch,
        remoteUrl,
        ...(input.env !== undefined ? { env: input.env } : {}),
        cwd: input.cwd,
      });
    } finally {
      cleanupTempBody(bodyFile);
    }
    handlePrResult(prResult, notice, error);
  } else if (remoteUrl !== null) {
    // Push was skipped; surface a compare URL so the user can open the
    // PR after they push manually.
    const compareUrl = buildCompareUrl({
      remoteUrl,
      defaultBranch,
      branch,
    });
    if (compareUrl !== null) {
      notice(`Open a PR manually after pushing: ${compareUrl}`);
    }
  }

  // -- persist PR URL on success --
  if (
    prResult !== null &&
    prResult.kind === "opened" &&
    prResult.url !== undefined
  ) {
    const withUrl: State = {
      ...advancedState,
      published_pr_url: prResult.url,
      updated_at: input.now,
    };
    writeState(paths.statePath, withUrl);
  }

  return finish(0, outLines, errLines);
}

// ---------- helpers ----------

function finish(
  exitCode: number,
  outLines: readonly string[],
  errLines: readonly string[],
): PublishResult {
  return {
    exitCode,
    stdout: outLines.length > 0 ? `${outLines.join("\n")}\n` : "",
    stderr: errLines.length > 0 ? `${errLines.join("\n")}\n` : "",
  };
}

function stripLeadingV(label: string): string {
  return label.startsWith("v") ? label.slice(1) : label;
}

function safePushBranch(args: {
  readonly repoPath: string;
  readonly remote: string;
  readonly branch: string;
  readonly granted: boolean;
  readonly noPush: boolean;
}): PushBranchResult {
  try {
    return pushBranch(args);
  } catch (err) {
    return {
      state: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function resolveRemoteUrl(cwd: string, remote: string): string | null {
  const res = spawnSync("git", ["remote", "get-url", remote], {
    cwd,
    encoding: "utf8",
  });
  if ((res.status ?? 1) !== 0) return null;
  const url = (res.stdout ?? "").trim();
  return url.length > 0 ? url : null;
}

function resolveDefaultBranch(cwd: string, remote: string): string {
  const head = spawnSync(
    "git",
    ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`],
    { cwd, encoding: "utf8" },
  );
  if ((head.status ?? 1) === 0) {
    const ref = (head.stdout ?? "").trim();
    const prefix = `refs/remotes/${remote}/`;
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  const cfg = spawnSync("git", ["config", "--get", "init.defaultBranch"], {
    cwd,
    encoding: "utf8",
  });
  if ((cfg.status ?? 1) === 0) {
    const v = (cfg.stdout ?? "").trim();
    if (v.length > 0) return v;
  }
  return "main";
}

function summarizeDegraded(state: State): string | null {
  if (!state.coupled_fallback) return null;
  const lead = state.adapters?.lead;
  if (lead?.effort_used !== undefined && lead.effort_requested !== undefined) {
    if (lead.effort_used !== lead.effort_requested) {
      return (
        `Lead ran at effort '${lead.effort_used}' ` +
        `(requested '${lead.effort_requested}').`
      );
    }
  }
  return "Coupled fallback active — one or more adapters ran below policy.";
}

function defaultProbe(input: PublishInput): () => PrCapabilityProbe {
  return () =>
    probePrCapability({
      gh: () => {
        const res = spawnSync("gh", ["auth", "status"], {
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            ...(input.env ?? {}),
          },
        });
        return {
          status: res.status ?? 1,
          stdout: res.stdout ?? "",
          stderr: res.stderr ?? "",
        };
      },
      glab: () => {
        const res = spawnSync("glab", ["auth", "status"], {
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            ...(input.env ?? {}),
          },
        });
        return {
          status: res.status ?? 1,
          stdout: res.stdout ?? "",
          stderr: res.stderr ?? "",
        };
      },
    });
}

function writeTempBody(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "samospec-publish-body-"));
  const file = path.join(dir, "body.md");
  writeFileSync(file, body, "utf8");
  return file;
}

function cleanupTempBody(file: string): void {
  try {
    rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function handlePrResult(
  prResult: OpenPrResult,
  notice: (s: string) => void,
  error: (s: string) => void,
): void {
  switch (prResult.kind) {
    case "opened":
      if (prResult.url !== undefined) {
        notice(`PR opened via ${prResult.tool}: ${prResult.url}`);
      } else {
        notice(`PR opened via ${prResult.tool}.`);
      }
      return;
    case "compare-url":
      notice(`Open a PR manually: ${prResult.url}`);
      return;
    case "failed":
      error(
        `samospec: ${prResult.tool} pr create failed: ${prResult.message}.`,
      );
      return;
    case "no-compare-url":
      error(`samospec: ${prResult.reason}`);
      return;
    default: {
      const _never: never = prResult;
      void _never;
    }
  }
}
