// Copyright 2026 Nikolay Samokhvalov.

// SPEC §5 Phases 1-5 — `samospec new <slug>`, end-to-end.
//
// Wires:
//   - lockfile acquisition (src/state/lock.ts)
//   - preflight cost estimate (src/policy/preflight.ts)
//   - consent gate when over threshold / subscription-auth (src/policy/consent.ts)
//   - branch creation on samospec/<slug> (src/git/branch.ts)
//   - persona proposal (src/cli/persona.ts)
//   - context discovery (src/context/*)
//   - 5-question interview (src/cli/interview.ts)
//   - v0.1 draft via revise() (src/cli/draft.ts)
//   - atomic writes of SPEC.md, TLDR.md, state.json, interview.json,
//     context.json, decisions.md, changelog.md
//   - first commit `spec(<slug>): draft v0.1` on samospec/<slug>
//   - session-end calibration sample (src/policy/calibration.ts)
//
// Notes:
//   - Push is consent-gated (first push per remote prompts for consent).
//   - Review loop runs via `samospec iterate`.
//   - The safety invariant from Issue #3 holds: never commit on a
//     protected branch (createSpecBranch throws with exit 2; specCommit
//     additionally refuses).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { archiveSlugDir } from "./archive.ts";

import { CodexAdapter } from "../adapter/codex.ts";
import type { Adapter } from "../adapter/types.ts";
import { discoverContext } from "../context/discover.ts";
import { contextJsonPath } from "../context/provenance.ts";
import {
  SPEC_BRANCH_PREFIX,
  branchExists,
  createSpecBranch,
} from "../git/branch.ts";
import { specCommit } from "../git/commit.ts";
import { ensureHasCommit } from "../git/ensure-has-commit.ts";
import { ProtectedBranchError, GitLayerUsageError } from "../git/errors.ts";
import { writeCalibrationSample } from "../policy/calibration.ts";
import {
  CONSENT_ABORT_EXIT_CODE,
  promptConsent,
  shouldPromptConsent,
  type ConsentAnswer,
} from "../policy/consent.ts";
import {
  computePreflight,
  formatPreflight,
  preflightConfigFromParsed,
  type PreflightAdapter,
} from "../policy/preflight.ts";
import { renderTldr } from "../render/tldr.ts";
import {
  LockContendedError,
  acquireLock,
  releaseLock,
  type LockHandle,
} from "../state/lock.ts";
import { advancePhase } from "../state/phase.ts";
import { newState, readState, writeState } from "../state/store.ts";
import type { State } from "../state/types.ts";
import {
  DraftTerminalError,
  authorDraft,
  formatLeadTerminalMessage,
} from "./draft.ts";
import {
  InterviewTerminalError,
  readInterview,
  runInterview,
  writeInterview,
  type InterviewResult,
  type OnQuestionCallback,
} from "./interview.ts";
import {
  PersonaTerminalError,
  extractSkill,
  proposePersona,
  type PersonaChoice,
  type PersonaProposal,
} from "./persona.ts";

const DEFAULT_MAX_WALL_CLOCK_MIN = 240;

// Session wall-clock cap: 10 minutes by default (#81).
// Configurable via budget.max_session_wall_clock_minutes in config.json,
// or overridden per-call via RunNewInput.maxSessionWallClockMs.
const DEFAULT_SESSION_WALL_CLOCK_MS = 10 * 60 * 1_000;

const V01_VERSION = "0.1.0" as const;

export interface RunNewResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ChoiceResolvers {
  readonly persona: (p: PersonaProposal) => Promise<PersonaChoice>;
  readonly question: OnQuestionCallback;
}

export interface RunNewInput {
  readonly cwd: string;
  readonly slug: string;
  readonly idea: string;
  readonly explain: boolean;
  readonly resolvers: ChoiceResolvers;
  readonly now: string;
  /** Test seam: inject a non-process pid when probing lock contention. */
  readonly pid?: number;
  /**
   * Legacy flag from the Sprint 2 skeleton: when true, a test-injected
   * `createBranch` stub is invoked instead of the real git-layer call.
   * When false or omitted, the real branch creation runs iff the repo
   * is a git checkout (as is the case once `samospec init` has been
   * followed by a `git init`). Outside a git repo the legacy behavior
   * is preserved for the skeleton tests.
   */
  readonly enableBranchCreation?: boolean;
  readonly createBranch?: (slug: string) => string;
  readonly maxWallClockMinutes?: number;
  /** Test seam: injects the consent-gate answer when the gate fires. */
  readonly consentAnswer?: ConsentAnswer;
  /**
   * When true, suppress push. Push is consent-gated by default per
   * SPEC §8. This flag is an explicit per-invocation override.
   */
  readonly noPush?: boolean;
  /**
   * Optional list of baseline section names to skip (SPEC §7 v0.2.0
   * --skip opt-out). Forwarded into `authorDraft` → `adapter.revise`.
   */
  readonly skipSections?: readonly string[];
  /**
   * When true, archive any pre-existing slug directory to
   * `.samo/spec/<slug>.archived-<timestamp>/` before starting a fresh
   * run (SPEC §10, issues #63 / #69). When false or omitted, a
   * pre-existing slug directory returns exit 1.
   */
  readonly force?: boolean;
  /**
   * When true, emit detailed progress lines. Default (false/omitted) keeps
   * stdout concise: status line per phase + final summary only. Dense
   * per-seat dumps and full prompt echoes are gated behind verbose=true.
   */
  readonly verbose?: boolean;
  /**
   * Test seam: inject a pre-built reviewer_a adapter so that
   * resolveSubscriptionAuth can be controlled in tests without spawning
   * a real codex binary. Production code omits this and uses
   * `new CodexAdapter()`.
   */
  readonly reviewerAAdapter?: Adapter;
  /**
   * Session wall-clock cap in milliseconds (#81). When the total elapsed
   * time since runNew() entry exceeds this value, the current phase is
   * preempted and runNew() returns exit 4 with a "session-wall-clock"
   * message. Falls back to budget.max_session_wall_clock_minutes from
   * config.json, then to DEFAULT_SESSION_WALL_CLOCK_MS (10 min).
   */
  readonly maxSessionWallClockMs?: number;
}

// ---------- session wall-clock guard (#81) ----------

/** Thrown by withDeadline() when the session wall-clock cap is exceeded. */
class SessionWallClockError extends Error {
  readonly phase: string;
  readonly elapsedMs: number;
  readonly limitMs: number;
  constructor(phase: string, elapsedMs: number, limitMs: number) {
    super(
      `session-wall-clock: ${phase} exceeded ${String(limitMs)}ms limit ` +
        `(elapsed ${String(elapsedMs)}ms)`,
    );
    this.name = "SessionWallClockError";
    this.phase = phase;
    this.elapsedMs = elapsedMs;
    this.limitMs = limitMs;
  }
}

/**
 * Race `promise` against a deadline derived from `startMs + limitMs`.
 * If the deadline fires first, throws `SessionWallClockError`.
 */
async function withDeadline<T>(
  promise: Promise<T>,
  phase: string,
  startMs: number,
  limitMs: number,
): Promise<T> {
  const remaining = limitMs - (Date.now() - startMs);
  if (remaining <= 0) {
    throw new SessionWallClockError(phase, Date.now() - startMs, limitMs);
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new SessionWallClockError(phase, Date.now() - startMs, limitMs));
    }, remaining);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/**
 * Resolve the session wall-clock limit (ms) from:
 * 1. input.maxSessionWallClockMs (explicit override)
 * 2. budget.max_session_wall_clock_minutes in config.json
 * 3. DEFAULT_SESSION_WALL_CLOCK_MS (10 min)
 */
function resolveSessionWallClockMs(input: RunNewInput): number {
  if (typeof input.maxSessionWallClockMs === "number") {
    return input.maxSessionWallClockMs;
  }
  try {
    const configPath = path.join(input.cwd, ".samo", "config.json");
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf8");
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      const budget = cfg["budget"];
      if (
        typeof budget === "object" &&
        budget !== null &&
        !Array.isArray(budget)
      ) {
        const minutes = (budget as Record<string, unknown>)[
          "max_session_wall_clock_minutes"
        ];
        if (typeof minutes === "number" && minutes > 0) {
          return Math.round(minutes * 60 * 1_000);
        }
      }
    }
  } catch {
    // config unreadable — fall through to default.
  }
  return DEFAULT_SESSION_WALL_CLOCK_MS;
}

// ---------- CLI entry ----------

export async function runNew(
  input: RunNewInput,
  adapter: Adapter,
): Promise<RunNewResult> {
  const lines: string[] = [];
  const errors: string[] = [];
  const notice = (line: string): void => {
    lines.push(line);
  };

  // Session wall-clock guard (#81): track start time and cap.
  const sessionStartMs = Date.now();
  const sessionLimitMs = resolveSessionWallClockMs(input);

  const samoDir = path.join(input.cwd, ".samo");
  const specsDir = path.join(samoDir, "spec");
  const slugDir = path.join(specsDir, input.slug);
  const lockPath = path.join(samoDir, ".lock");

  // Slug collision guard (SPEC §10): refuse any pre-existing slug
  // directory and suggest resume / --force.
  if (existsSync(slugDir)) {
    if (input.force) {
      // Archive the old run to .samo/spec/<slug>.archived-<ts>/ per SPEC §10.
      const result = archiveSlugDir({
        specsDir,
        slug: input.slug,
        now: new Date(input.now),
      });
      if (result.kind === "archived") {
        const archiveName = path.basename(result.archivedPath);
        notice(`archived existing run to .samo/spec/${archiveName}/`);
      }
    } else {
      errors.push(
        `samospec: .samo/spec/${input.slug}/ already exists. ` +
          `Try \`samospec resume ${input.slug}\` or ` +
          `\`samospec new ${input.slug} --force\` to archive the old run.`,
      );
      return {
        exitCode: 1,
        stdout: lines.join("\n"),
        stderr: `${errors.join("\n")}\n`,
      };
    }
  }

  // Lockfile acquisition (SPEC §5 Phase 1).
  let handle: LockHandle;
  try {
    handle = acquireLock({
      lockPath,
      slug: input.slug,
      now: Date.parse(input.now),
      maxWallClockMinutes:
        input.maxWallClockMinutes ?? DEFAULT_MAX_WALL_CLOCK_MIN,
      pid: input.pid ?? process.pid,
    });
  } catch (err) {
    if (err instanceof LockContendedError) {
      errors.push(
        `samospec: another samospec run holds the repo lock (pid ${err.holderPid}). ` +
          `Wait for it to exit or remove ${err.lockPath} if stale.`,
      );
      return {
        exitCode: 2,
        stdout: lines.join("\n"),
        stderr: `${errors.join("\n")}\n`,
      };
    }
    throw err;
  }

  try {
    // Preflight cost estimate (SPEC §5 Phase 1 + §11).
    const reviewerAAdapter: Adapter =
      input.reviewerAAdapter ?? new CodexAdapter();
    const [leadSubAuth, reviewerASubAuth] = await Promise.all([
      resolveSubscriptionAuth(adapter),
      resolveSubscriptionAuth(reviewerAAdapter),
    ]);
    const preflightRes = runPreflight({
      cwd: input.cwd,
      adapter,
      subscriptionAuth: leadSubAuth,
      reviewerASubscriptionAuth: reviewerASubAuth,
    });
    if (preflightRes.ok) {
      notice(preflightRes.text);
    } else {
      notice(
        `preflight: ${preflightRes.reason} — continuing with scaffold defaults.`,
      );
    }

    // Consent gate (SPEC §11). When the threshold trips or any
    // adapter reports usage: null, callers must supply `consentAnswer`.
    // Tests pass a deterministic answer; interactive CLI wires stdin.
    if (preflightRes.ok) {
      const preflightForGate = {
        likelyUsd: preflightRes.estimate.likelyUsd,
        anyUsageNull: Object.values(preflightRes.estimate.perAdapter).some(
          (e) => typeof e.usd !== "number",
        ),
      };
      if (shouldPromptConsent(preflightForGate, preflightRes.thresholdUsd)) {
        // Default to accept when the gate fires and no answer was
        // supplied (CI / tests that don't care about the consent path).
        const consent = promptConsent({
          preflight: preflightForGate,
          thresholdUsd: preflightRes.thresholdUsd,
          answer: input.consentAnswer ?? "accept",
        });
        if (consent.decision === "abort") {
          errors.push(
            `samospec: preflight consent refused. Exiting without writing a spec.`,
          );
          return {
            exitCode: consent.exitCode ?? CONSENT_ABORT_EXIT_CODE,
            stdout: lines.join("\n"),
            stderr: `${errors.join("\n")}\n`,
          };
        }
        if (consent.decision === "downshift") {
          notice(
            `consent: running this session at effort=high (not persisted).`,
          );
        }
      }
    }

    // Empty-repo guard (Issue #65): if the repo has no commits yet,
    // create an empty initial commit so that HEAD is resolvable before
    // branch operations that require it.
    try {
      const initResult = ensureHasCommit({ repoPath: input.cwd });
      if (initResult.created) {
        notice("No commits found — created initial commit.");
      }
    } catch {
      // Outside a real git repo (skeleton / non-git tests) this may
      // fail; ignore and let the branch-creation step report the error.
    }

    // Branch creation (SPEC §5 Phase 1 + §8).
    // Two modes:
    //   - test seam (input.enableBranchCreation===true + createBranch):
    //     invoke the stub and skip the real git-layer call.
    //   - default: try the real `createSpecBranch`. Outside a git repo
    //     this throws; we catch + surface "branch creation skipped"
    //     so legacy tests that don't initialize a git repo still run.
    let branchResult = createBranch(input);
    if (branchResult.kind === "protected") {
      errors.push(
        `samospec: refusing to branch on protected branch '${branchResult.branch}'. ` +
          `Check out a feature branch first or override protection via ` +
          `git config / .samo/config.json.`,
      );
      return {
        exitCode: 2,
        stdout: lines.join("\n"),
        stderr: `${errors.join("\n")}\n`,
      };
    }
    if (branchResult.kind === "created") {
      notice(`branch created: ${branchResult.branch}`);
    } else if (branchResult.kind === "exists") {
      // #94: a prior crashed run left this branch behind. Check it out
      // so the v0.1 draft lands on the right ref and is not silently
      // skipped.
      //
      // PR #99 review must-fix: if the checkout itself fails (e.g. a
      // dirty working tree on the caller's feature branch would be
      // overwritten by the checkout), HEAD stays on the caller's branch.
      // We MUST demote the branchResult to "skipped" so the downstream
      // commit gate does not fire `specCommit` and leak the v0.1 draft
      // onto `feat/...`. Abort the whole run with exit 2 (same class as
      // the protected-branch refusal path) so the caller knows no work
      // landed and can resolve the conflict before retrying.
      try {
        checkoutExistingBranch(branchResult.branch, input.cwd);
        notice(
          `branch ${branchResult.branch} already exists — checked out to resume on it.`,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const existing = branchResult.branch;
        branchResult = {
          kind: "skipped",
          reason:
            `could not check out existing ${existing} ` +
            `(create-branch error: ${branchResult.reason}; ` +
            `checkout error: ${detail})`,
        };
        errors.push(
          `samospec: branch '${existing}' already exists but ` +
            `\`git checkout ${existing}\` failed: ${detail}. ` +
            `Aborting to avoid committing the v0.1 draft onto the ` +
            `current branch. Resolve the conflict (e.g. stash or ` +
            `commit local changes, or delete/rename ${existing}) ` +
            `and rerun \`samospec new ${input.slug}\`.`,
        );
        return {
          exitCode: 2,
          stdout: lines.join("\n"),
          stderr: `${errors.join("\n")}\n`,
        };
      }
    } else if (branchResult.kind === "skipped") {
      notice(`branch creation skipped (${branchResult.reason}).`);
    } else if (branchResult.kind === "stub") {
      notice(`branch stub invoked: samospec/${input.slug}.`);
    }

    // Materialize the slug directory.
    mkdirSync(slugDir, { recursive: true });

    // Initial state.json. Starts at phase 'detect' and advances as we
    // make progress so a crash leaves a truthful state record.
    // #85: persist input.idea immediately so resume and iterate can
    // thread it into prompt builders even if new is interrupted early.
    let state = {
      ...newState({ slug: input.slug, now: input.now }),
      ...(input.idea.trim().length > 0 ? { input: { idea: input.idea } } : {}),
    };
    const statePath = path.join(slugDir, "state.json");
    writeState(statePath, state);

    state = advancePhase(state, "branch_lock_preflight", { now: input.now });
    writeState(statePath, state);

    // Phase 2 — persona.
    state = advancePhase(state, "persona", { now: input.now });
    writeState(statePath, state);

    const subAuth = await resolveSubscriptionAuth(adapter);
    let persona: PersonaProposal;
    try {
      persona = await withDeadline(
        proposePersonaInteractive(
          {
            idea: input.idea,
            explain: input.explain,
            subscriptionAuth: subAuth,
            onNotice: notice,
            resolver: input.resolvers.persona,
          },
          adapter,
        ),
        "persona",
        sessionStartMs,
        sessionLimitMs,
      );
    } catch (err) {
      if (err instanceof SessionWallClockError) {
        state = { ...state, round_state: "lead_terminal" };
        state.updated_at = input.now;
        writeState(statePath, state);
        errors.push(
          `samospec: session-wall-clock exceeded at persona phase ` +
            `(${String(err.elapsedMs)}ms elapsed, limit ${String(err.limitMs)}ms). ` +
            `Restart with --force or increase budget.max_session_wall_clock_minutes.`,
        );
        return {
          exitCode: 4,
          stdout: lines.join("\n"),
          stderr: `${errors.join("\n")}\n`,
        };
      }
      if (err instanceof PersonaTerminalError) {
        state = { ...state, round_state: "lead_terminal" };
        state.updated_at = input.now;
        writeState(statePath, state);
        errors.push(
          `samospec: lead_terminal at persona — ${err.detail}. ` +
            `Edit .samo/spec/${input.slug}/ manually or restart with --force.`,
        );
        return {
          exitCode: 4,
          stdout: lines.join("\n"),
          stderr: `${errors.join("\n")}\n`,
        };
      }
      throw err;
    }

    state = {
      ...state,
      persona: { skill: persona.skill, accepted: persona.accepted },
      updated_at: input.now,
    };
    writeState(statePath, state);
    notice(`persona accepted: ${persona.persona}`);

    // Phase 3 — context discovery (SPEC §7).
    state = advancePhase(state, "context", { now: input.now });
    writeState(statePath, state);

    const ctxPath = contextJsonPath(input.cwd, input.slug);
    let chunks: readonly string[] = [];
    try {
      const discovered = discoverContext({
        repoPath: input.cwd,
        slug: input.slug,
        phase: "draft",
        contextPaths: [],
      });
      chunks = discovered.chunks;
      notice(
        `context: ${String(discovered.context.files.filter((f) => f.included).length)} file(s) included ` +
          `(${String(discovered.context.budget.tokens_used)} tokens); ` +
          `context.json -> ${path.relative(input.cwd, ctxPath)}`,
      );
    } catch (err) {
      // Outside a git repo (skeleton tests), `listTrackedAndUntracked`
      // will fail. Gracefully skip context — we still need to emit a
      // minimal empty context.json so the file set is complete.
      notice(
        `context discovery skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      const empty = {
        phase: "draft" as const,
        files: [],
        risk_flags: [],
        budget: { phase: "draft" as const, tokens_used: 0, tokens_budget: 0 },
      };
      // Write a placeholder so the committed-artifact set matches SPEC §9.
      // We do this directly because `writeContextJson` enforces the same
      // schema.
      const { writeContextJson } = await import("../context/provenance.ts");
      writeContextJson(ctxPath, empty);
    }

    // Phase 4 — interview.
    state = advancePhase(state, "interview", { now: input.now });
    writeState(statePath, state);

    const interviewPath = path.join(slugDir, "interview.json");
    let interview: InterviewResult;
    try {
      interview = await withDeadline(
        runInterview(
          {
            slug: input.slug,
            persona: persona.persona,
            explain: input.explain,
            subscriptionAuth: subAuth,
            onQuestion: input.resolvers.question,
            onNotice: notice,
            outputPath: interviewPath,
            now: input.now,
          },
          adapter,
        ),
        "interview",
        sessionStartMs,
        sessionLimitMs,
      );
    } catch (err) {
      if (err instanceof SessionWallClockError) {
        state = { ...state, round_state: "lead_terminal" };
        state.updated_at = input.now;
        writeState(statePath, state);
        errors.push(
          `samospec: session-wall-clock exceeded at interview phase ` +
            `(${String(err.elapsedMs)}ms elapsed, limit ${String(err.limitMs)}ms). ` +
            `Restart with --force or increase budget.max_session_wall_clock_minutes.`,
        );
        return {
          exitCode: 4,
          stdout: lines.join("\n"),
          stderr: `${errors.join("\n")}\n`,
        };
      }
      if (err instanceof InterviewTerminalError) {
        state = { ...state, round_state: "lead_terminal" };
        state.updated_at = input.now;
        writeState(statePath, state);
        errors.push(
          `samospec: lead_terminal at interview — ${err.message}. ` +
            `Edit .samo/spec/${input.slug}/ manually or restart with --force.`,
        );
        return {
          exitCode: 4,
          stdout: lines.join("\n"),
          stderr: `${errors.join("\n")}\n`,
        };
      }
      errors.push(
        `samospec: interview interrupted — ${
          err instanceof Error ? err.message : String(err)
        }.\n` +
          `State persisted; run \`samospec resume ${input.slug}\` to continue.`,
      );
      return {
        exitCode: 3,
        stdout: lines.join("\n"),
        stderr: `${errors.join("\n")}\n`,
      };
    }

    notice(
      `interview complete: ${String(interview.answers.length)} answer(s) recorded.`,
    );

    // Phase 5 — v0.1 draft.
    state = advancePhase(state, "draft", { now: input.now });
    writeState(statePath, state);

    let draft;
    try {
      draft = await withDeadline(
        authorDraft(
          {
            slug: input.slug,
            idea: input.idea,
            persona: persona.persona,
            interview,
            contextChunks: chunks,
            explain: input.explain,
            ...(input.skipSections !== undefined
              ? { skipSections: input.skipSections }
              : {}),
          },
          adapter,
        ),
        "draft",
        sessionStartMs,
        sessionLimitMs,
      );
    } catch (err) {
      if (err instanceof SessionWallClockError) {
        state = { ...state, round_state: "lead_terminal" };
        state.updated_at = input.now;
        writeState(statePath, state);
        errors.push(
          `samospec: session-wall-clock exceeded at draft phase ` +
            `(${String(err.elapsedMs)}ms elapsed, limit ${String(err.limitMs)}ms). ` +
            `Restart with --force or increase budget.max_session_wall_clock_minutes.`,
        );
        return {
          exitCode: 4,
          stdout: lines.join("\n"),
          stderr: `${errors.join("\n")}\n`,
        };
      }
      if (err instanceof DraftTerminalError) {
        state = { ...state, round_state: "lead_terminal" };
        state.updated_at = input.now;
        writeState(statePath, state);
        errors.push(
          formatLeadTerminalMessage(input.slug, err.sub_reason, err.detail),
        );
        return {
          exitCode: 4,
          stdout: lines.join("\n"),
          stderr: `${errors.join("\n")}\n`,
        };
      }
      throw err;
    }

    // ---------- write committed artifacts (SPEC §9) ----------

    const specPath = path.join(slugDir, "SPEC.md");
    const tldrPath = path.join(slugDir, "TLDR.md");
    const decisionsPath = path.join(slugDir, "decisions.md");
    const changelogPath = path.join(slugDir, "changelog.md");

    // SPEC.md: lead's draft verbatim.
    writeFileSync(specPath, ensureTrailingNewline(draft.spec), "utf8");

    // TLDR.md: heuristic render. Pass state so the Next-action section
    // is derived from state via computeNextAction (#96).
    const tldr = renderTldr(draft.spec, { slug: input.slug, state });
    writeFileSync(tldrPath, tldr, "utf8");

    // decisions.md: empty seed; populated by the review loop.
    writeFileSync(
      decisionsPath,
      `# decisions\n\n- No review-loop decisions yet.\n`,
      "utf8",
    );

    // changelog.md: first entry — v0.1 draft from the lead.
    const changelogLines: string[] = [
      `# changelog`,
      ``,
      `## v0.1 — ${input.now}`,
      ``,
      `- Initial draft authored by the lead.`,
      `- Persona: ${persona.persona}`,
    ];
    if (state.coupled_fallback) {
      changelogLines.push(`- Coupled fallback recorded (SPEC §11).`);
    }
    changelogLines.push(``);
    writeFileSync(changelogPath, changelogLines.join("\n"), "utf8");

    // interview.json already written by runInterview; confirm existence
    // so a regression test that breaks this has a clear failure point.
    if (!existsSync(interviewPath)) {
      // Re-write from the in-memory result as a defensive belt.
      writeInterview(interviewPath, {
        slug: interview.slug,
        persona: interview.persona,
        generated_at: interview.generated_at,
        questions: [...interview.questions],
        answers: [...interview.answers],
      });
    }

    // state.json: advance to committed, version v0.1, round 0.
    // `state.input.idea` was already written at initialization time (#85)
    // so resume + iterate have it even if new was interrupted.
    state = {
      ...state,
      round_state: "committed",
      round_index: 0,
      version: V01_VERSION,
      updated_at: input.now,
    };
    writeState(statePath, state);

    // ---------- first commit on samospec/<slug> ----------
    //
    // #94: commit whenever we're sitting on a real spec branch —
    // either freshly created OR one that survived a prior crashed run
    // and was just checked out. The previous gate skipped the commit
    // on the `exists` path, leaving `state.json.round_state=committed`
    // untrue against a dirty working tree.

    if (branchResult.kind === "created" || branchResult.kind === "exists") {
      try {
        specCommit({
          repoPath: input.cwd,
          slug: input.slug,
          action: "draft",
          version: "0.1",
          paths: [
            path.relative(input.cwd, path.join(slugDir, "SPEC.md")),
            path.relative(input.cwd, path.join(slugDir, "TLDR.md")),
            path.relative(input.cwd, path.join(slugDir, "state.json")),
            path.relative(input.cwd, path.join(slugDir, "interview.json")),
            path.relative(input.cwd, path.join(slugDir, "context.json")),
            path.relative(input.cwd, path.join(slugDir, "decisions.md")),
            path.relative(input.cwd, path.join(slugDir, "changelog.md")),
          ],
        });
        notice(
          `committed spec(${input.slug}): draft v0.1 on samospec/${input.slug}`,
        );
      } catch (err) {
        if (err instanceof ProtectedBranchError) {
          state = { ...state, round_state: "lead_revised" };
          state.updated_at = input.now;
          writeState(statePath, state);
          errors.push(
            `samospec: refusing to commit on protected branch '${err.branchName}'. ` +
              `Check out a feature branch and run \`samospec resume ${input.slug}\`.`,
          );
          return {
            exitCode: 2,
            stdout: lines.join("\n"),
            stderr: `${errors.join("\n")}\n`,
          };
        }
        throw err;
      }
    } else {
      notice(`commit skipped (no git branch created).`);
    }

    // ---------- calibration sample (SPEC §11) ----------

    try {
      const tokens = approximateSessionTokens({ draftUsage: draft.usage });
      const costUsd = extractCostUsd(draft.usage);
      writeCalibrationSample({
        cwd: input.cwd,
        session_actual_tokens: tokens,
        session_actual_cost_usd: costUsd,
        session_rounds: 0,
      });
    } catch (err) {
      // Calibration is best-effort; never halt a successful draft
      // commit on calibration failure. Surface the issue so a user
      // running with `--explain` sees it.
      notice(
        `calibration sample skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // ---------- TL;DR preview + resume hint ----------

    notice("");
    notice("TL;DR");
    notice(tldr);
    notice(
      `next: \`samospec iterate ${input.slug}\` to start the review loop, ` +
        `or \`samospec resume ${input.slug}\` to pick up later.`,
    );

    return {
      exitCode: 0,
      stdout: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
      stderr: "",
    };
  } finally {
    releaseLock(handle);
  }
}

// ---------- preflight helper ----------

interface PreflightRunOk {
  readonly ok: true;
  readonly text: string;
  readonly estimate: ReturnType<typeof computePreflight>;
  readonly thresholdUsd: number;
}
interface PreflightRunSkipped {
  readonly ok: false;
  readonly reason: string;
}

function runPreflight(args: {
  cwd: string;
  adapter: Adapter;
  subscriptionAuth: boolean;
  reviewerASubscriptionAuth?: boolean;
}): PreflightRunOk | PreflightRunSkipped {
  const configPath = path.join(args.cwd, ".samo", "config.json");
  if (!existsSync(configPath)) {
    return { ok: false, reason: "config.json missing; run samospec init" };
  }
  let parsed: Record<string, unknown>;
  try {
    const raw = readFileSync(configPath, "utf8");
    const json: unknown = JSON.parse(raw);
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      return { ok: false, reason: "config.json malformed" };
    }
    parsed = json as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      reason: `config.json unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let config;
  try {
    config = preflightConfigFromParsed(parsed);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const adapters: readonly PreflightAdapter[] = [
    {
      id: "lead",
      vendor: args.adapter.vendor,
      role: "lead",
      subscription_auth: args.subscriptionAuth,
    },
    {
      id: "reviewer_a",
      vendor: config.adapters.reviewer_a.adapter,
      role: "reviewer_a",
      subscription_auth: args.reviewerASubscriptionAuth ?? false,
    },
    {
      id: "reviewer_b",
      vendor: config.adapters.reviewer_b.adapter,
      role: "reviewer_b",
      subscription_auth: args.subscriptionAuth,
    },
  ];
  const estimate = computePreflight(config, adapters);
  const text = formatPreflight(estimate);
  return {
    ok: true,
    text,
    estimate,
    thresholdUsd: config.budget.preflight_confirm_usd,
  };
}

// ---------- branch helpers ----------

type BranchCreation =
  | { kind: "created"; branch: string }
  | { kind: "exists"; branch: string; reason: string }
  | { kind: "skipped"; reason: string }
  | { kind: "stub"; branch: string }
  | { kind: "protected"; branch: string };

/**
 * #94: when `createSpecBranch` reports that `samospec/<slug>` already
 * exists (a prior crashed run left it behind), we check it out so the
 * v0.1 draft commit lands on the right ref. Kept local — the git layer
 * only exposes create-new semantics, and this is a new.ts-only recovery
 * path.
 */
function checkoutExistingBranch(branch: string, repoPath: string): void {
  const result = spawnSync("git", ["checkout", branch], {
    cwd: repoPath,
    encoding: "utf8",
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `git checkout ${branch} failed with status ${String(result.status)}: ${
        result.stderr ?? ""
      }`,
    );
  }
}

function createBranch(input: RunNewInput): BranchCreation {
  if (input.enableBranchCreation === true) {
    if (input.createBranch !== undefined) {
      const branch = input.createBranch(input.slug);
      return { kind: "stub", branch };
    }
    // Fall through — caller asked for real branch creation.
  }
  try {
    const branch = createSpecBranch(input.slug, { repoPath: input.cwd });
    return { kind: "created", branch };
  } catch (err) {
    if (err instanceof ProtectedBranchError) {
      return { kind: "protected", branch: err.branchName };
    }
    // Issue #94: a `samospec/<slug>` branch surviving a prior crashed
    // run is a recoverable condition — check it out and commit on it
    // below rather than silently dropping the auto-commit.
    const target = `${SPEC_BRANCH_PREFIX}${input.slug}`;
    if (err instanceof GitLayerUsageError && branchExists(target, input.cwd)) {
      return { kind: "exists", branch: target, reason: err.message };
    }
    if (err instanceof GitLayerUsageError) {
      return { kind: "skipped", reason: err.message };
    }
    return {
      kind: "skipped",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------- subsystem helpers ----------

async function resolveSubscriptionAuth(adapter: Adapter): Promise<boolean> {
  try {
    const auth = await adapter.auth_status();
    return auth.subscription_auth === true;
  } catch {
    return false;
  }
}

interface PersonaInteractiveInput {
  readonly idea: string;
  readonly explain: boolean;
  readonly subscriptionAuth: boolean;
  readonly onNotice: (line: string) => void;
  readonly resolver: (p: PersonaProposal) => Promise<PersonaChoice>;
}

async function proposePersonaInteractive(
  input: PersonaInteractiveInput,
  adapter: Adapter,
): Promise<PersonaProposal> {
  const draft = await proposePersona(
    {
      idea: input.idea,
      explain: input.explain,
      subscriptionAuth: input.subscriptionAuth,
      onNotice: input.onNotice,
      choice: { kind: "accept" },
    },
    adapter,
  );
  input.onNotice(`proposed persona: ${draft.persona}`);
  input.onNotice(`rationale: ${draft.rationale}`);
  const choice = await input.resolver(draft);
  if (choice.kind === "accept") return draft;
  if (choice.kind === "edit") {
    return {
      persona: `Veteran "${choice.skill}" expert`,
      skill: choice.skill,
      rationale: draft.rationale,
      accepted: true,
    };
  }
  // replace
  const skill = extractSkill(choice.persona);
  if (skill === null) {
    throw new PersonaTerminalError(
      "schema_violation",
      `replacement persona did not match Veteran "<skill>" expert: ${choice.persona}`,
    );
  }
  return {
    persona: choice.persona,
    skill,
    rationale: draft.rationale,
    accepted: true,
  };
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

// ---------- calibration inputs ----------

/**
 * Rough token total for the session. The first draft runs through
 * `revise()` exactly once; if the adapter reported usage we take
 * `input_tokens + output_tokens`, otherwise we fall back to a small
 * constant that keeps the array length in lockstep with cost_per_run.
 */
function approximateSessionTokens(args: {
  draftUsage: { input_tokens?: number; output_tokens?: number } | null;
}): number {
  const u = args.draftUsage;
  if (u === null || u === undefined) return 0;
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
}

function extractCostUsd(
  usage: { cost_usd?: number | undefined } | null,
): number | null {
  if (usage === null || usage === undefined) return null;
  if (typeof usage.cost_usd !== "number") return null;
  return usage.cost_usd;
}

// ---------- diagnostic readers (used by resume) ----------

export interface SpecPaths {
  readonly slugDir: string;
  readonly statePath: string;
  readonly interviewPath: string;
  readonly lockPath: string;
  readonly specPath: string;
  readonly tldrPath: string;
  readonly contextPath: string;
  readonly decisionsPath: string;
  readonly changelogPath: string;
}

export function specPaths(cwd: string, slug: string): SpecPaths {
  const slugDir = path.join(cwd, ".samo", "spec", slug);
  return {
    slugDir,
    statePath: path.join(slugDir, "state.json"),
    interviewPath: path.join(slugDir, "interview.json"),
    lockPath: path.join(cwd, ".samo", ".lock"),
    specPath: path.join(slugDir, "SPEC.md"),
    tldrPath: path.join(slugDir, "TLDR.md"),
    contextPath: path.join(slugDir, "context.json"),
    decisionsPath: path.join(slugDir, "decisions.md"),
    changelogPath: path.join(slugDir, "changelog.md"),
  };
}

export interface SpecInspection {
  readonly state: State | null;
  readonly hasInterview: boolean;
  readonly hasSpec: boolean;
  readonly hasTldr: boolean;
  readonly hasContext: boolean;
}

export function inspectSpec(cwd: string, slug: string): SpecInspection {
  const paths = specPaths(cwd, slug);
  const state = readState(paths.statePath);
  return {
    state,
    hasInterview: readInterview(paths.interviewPath) !== null,
    hasSpec: existsSync(paths.specPath),
    hasTldr: existsSync(paths.tldrPath),
    hasContext: existsSync(paths.contextPath),
  };
}
