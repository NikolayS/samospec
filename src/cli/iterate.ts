// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §10 `samospec iterate` — multi-round review loop.
 *
 * Default: run rounds until a stopping condition fires. `--rounds N`
 * caps for this invocation.
 *
 * Preconditions:
 *   - `.samo/spec/<slug>/state.json` exists (exit 1 otherwise with
 *     `samospec new <slug>` suggestion).
 *   - State is at `phase=draft` or `phase=review_loop`, not
 *     `lead_terminal`.
 *   - Safety invariant: never commits on a protected branch.
 *
 * Each iteration:
 *   1. Detect manual edits (SPEC §7 Phase 6 pre-step).
 *   2. Allocate round dir + round.json.
 *   3. Call runRound (parallel reviewers + lead revise).
 *   4. If degraded resolution is new this session, prompt once
 *      `[accept / abort]`.
 *   5. Write SPEC.md, TLDR.md, decisions.md append, changelog.md
 *      append. Bump version.
 *   6. Commit via specCommit (refuses on protected branches).
 *   7. Evaluate all 8 stopping conditions; halt if any fires.
 *
 * Scope guards (from Issue #26):
 *   - NO push (Sprint 4).
 *   - NO publish (Sprint 4).
 *   - NO reviewer system-prompt changes beyond wiring.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Adapter, Finding } from "../adapter/types.ts";
import { currentBranch } from "../git/branch.ts";
import { specCommit } from "../git/commit.ts";
import { ProtectedBranchError } from "../git/errors.ts";
import { isProtected } from "../git/protected.ts";
import {
  applyManualEdit,
  detectManualEdits,
  type ManualEditChoice,
} from "../git/manual-edit.ts";
import { pushBranch, type PushBranchResult } from "../git/push.ts";
import {
  probePrCapability,
  requestPushConsent,
  type PushConsentDecision,
  type PushConsentPrompt,
} from "../git/push-consent.ts";
import {
  shouldStartNextRound,
  type CallTimeoutsMs,
} from "../policy/wallclock.ts";
import { injectArchitectureBlock } from "../render/architecture-spec.ts";
import { renderTldr } from "../render/tldr.ts";
import { readArchitectureOrEmpty } from "../state/architecture-store.ts";
import {
  acquireLock,
  releaseLock,
  type LockHandle,
  LockContendedError,
} from "../state/lock.ts";
import { computeNextAction } from "../state/next-action.ts";
import { writeState } from "../state/store.ts";
import { stateSchema, type State } from "../state/types.ts";
import { specPaths } from "./new.ts";
import {
  appendRoundDecisions,
  countDecisions,
  readDecisionsFile,
  type ReviewDecision,
} from "../loop/decisions.ts";
import {
  detectDegradedResolution,
  formatDegradedSummary,
  type AdapterResolutionSnapshot,
} from "../loop/degradation.ts";
import {
  CRITIQUE_TIMEOUT_MS,
  REVISE_TIMEOUT_MS,
  countDiffLines,
  countNonSummaryCategoriesWithFindings,
  roundDirsFor,
  runRound,
  type SeatErrorDetail,
} from "../loop/round.ts";
import {
  classifyAllStops,
  stopReasonExitCode,
  stopReasonMessage,
  type StopReason,
} from "../loop/stopping.ts";
import {
  bumpMinor,
  formatChangelogEntry,
  formatVersionLabel,
} from "../loop/version.ts";
import {
  classifyLeadTerminal,
  formatLeadTerminalMessage,
} from "./terminal-messages.ts";
import {
  createProgressReporter,
  type ProgressOptions,
  type ProgressReporter,
} from "./iterate-progress.ts";

// ---------- constants ----------

const DEFAULT_MAX_ROUNDS = 10 as const;
const DEFAULT_WALL_CLOCK_MS = 240 * 60 * 1000; // 240 minutes
const DEFAULT_MAX_WALL_CLOCK_MIN = 240;
// Issue #91: session wall-clock cap default for `samospec iterate`,
// mirroring `samospec new`. Configurable via
// `budget.max_session_wall_clock_minutes` in `.samo/config.json` or
// overridden per-call via `IterateInput.maxSessionWallClockMs`.
const DEFAULT_SESSION_WALL_CLOCK_MS = 10 * 60 * 1_000;

// ---------- types ----------

export type DegradeChoice = "accept" | "abort";
export type ManualEditResolver = (
  files: readonly string[],
) => Promise<ManualEditChoice>;
export type DegradeResolver = (summary: string) => Promise<DegradeChoice>;
export type ContinueReviewersChoice = "continue" | "abort";

/**
 * Per-seat diagnostic payload for the reviewer-exhausted prompt (Issue #52).
 */
export interface SeatDiagnostics {
  readonly reviewer_a: {
    readonly vendor: string;
    readonly errorDetail?: SeatErrorDetail;
  };
  readonly reviewer_b: {
    readonly vendor: string;
    readonly errorDetail?: SeatErrorDetail;
  };
}

export type ContinueReviewersResolver = (
  diag?: SeatDiagnostics,
) => Promise<ContinueReviewersChoice>;

/** SPEC §8 — first-push consent resolver. See src/git/push-consent.ts. */
export type PushConsentResolver = (
  payload: PushConsentPrompt,
) => Promise<PushConsentDecision>;

export interface IterateResolvers {
  readonly onManualEdit: ManualEditResolver;
  readonly onDegraded: DegradeResolver;
  readonly onReviewerExhausted: ContinueReviewersResolver;
  /**
   * SPEC §8: first time a push would happen for a remote URL in this
   * repo, invoke this resolver once. Persisted decisions silently
   * short-circuit the resolver on later sessions.
   */
  readonly onPushConsent?: PushConsentResolver;
}

export interface PushOptions {
  /** Remote name to target (e.g. `origin`). */
  readonly remote: string;
  /** `--no-push` invocation override; beats persisted consent per §8. */
  readonly noPush: boolean;
}

export interface IterateInput {
  readonly cwd: string;
  readonly slug: string;
  readonly now: string;
  readonly resolvers: IterateResolvers;
  readonly pid?: number;
  readonly maxRounds?: number;
  readonly maxWallClockMs?: number;
  readonly maxWallClockMinutes?: number;
  readonly sessionStartedAtMs?: number;
  readonly nowMs?: number;
  readonly adapters: {
    readonly lead: Adapter;
    readonly reviewerA: Adapter;
    readonly reviewerB: Adapter;
  };
  /** Optional per-call timeouts override (tests tweak). */
  readonly callTimeouts?: Partial<CallTimeoutsMs>;
  /** Resolutions snapshot for degraded detection. When omitted, uses
   *  adapter.vendor + models() to derive a best-effort snapshot. */
  readonly resolutions?: {
    readonly lead: AdapterResolutionSnapshot;
    readonly reviewer_a: AdapterResolutionSnapshot;
    readonly reviewer_b: AdapterResolutionSnapshot;
    readonly coupled_fallback: boolean;
  };
  /** When true (default), degraded prompt is asked on the first round
   *  that enters a degraded resolution. */
  readonly degradeOnFirstRound?: boolean;
  /** A pre-fired signal for SIGINT-style tests. */
  readonly sigintSignal?: { readonly triggered: boolean };
  /**
   * SPEC §8 — when present, triggers the round-boundary push flow.
   * Absent = local-only, no consent prompt, no push attempts.
   */
  readonly pushOptions?: PushOptions;
  /**
   * Issue #101: when true, suppress per-phase progress + heartbeat.
   * Final summary lines still go to stdout. Default: false (verbose).
   */
  readonly quiet?: boolean;
  /**
   * Issue #101: test-injection surface for clock + scheduler so the
   * heartbeat can be exercised without real wall-clock sleeps.
   */
  readonly progress?: ProgressOptions;
  /**
   * Issue #91: session wall-clock cap in milliseconds. Mirrors the
   * `--max-session-wall-clock-ms` semantics in `samospec new`: when the
   * total elapsed time since `runIterate()` entry exceeds this value,
   * the current round / seat call is preempted and `runIterate` returns
   * exit 4 with a `session-wall-clock` message in stderr. Falls back to
   * `budget.max_session_wall_clock_minutes` in `.samo/config.json`, then
   * to `DEFAULT_SESSION_WALL_CLOCK_MS` (10 min). Independent of the
   * SPEC §11 "one more round fits" guard (`maxWallClockMs`) — the two
   * caps compose: whichever is tighter fires first.
   */
  readonly maxSessionWallClockMs?: number;
}

export interface IterateResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly roundsRun: number;
  readonly finalVersion?: string;
  readonly stopReason?: StopReason;
}

// ---------- main ----------

export async function runIterate(input: IterateInput): Promise<IterateResult> {
  const lines: string[] = [];
  const errLines: string[] = [];
  const notice = (line: string): void => {
    lines.push(line);
  };
  const error = (line: string): void => {
    errLines.push(line);
  };
  // Issue #101: progress + heartbeat stream. Everything the reporter
  // emits lands on stderr alongside actual errors — never on stdout,
  // so stdout-parsing scripts don't break. When `quiet: true`, the
  // reporter returned here is a no-op shim.
  const progress: ProgressReporter = createProgressReporter({
    emit: (line: string): void => {
      errLines.push(line);
    },
    quiet: input.quiet ?? false,
    ...(input.progress !== undefined ? { options: input.progress } : {}),
  });

  const paths = specPaths(input.cwd, input.slug);

  if (!existsSync(paths.statePath)) {
    error(
      `samospec: no spec found for slug '${input.slug}'. ` +
        `Run \`samospec new ${input.slug}\` to start one.`,
    );
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${errLines.join("\n")}\n`,
      roundsRun: 0,
    };
  }

  // Read state.
  const parsedState = stateSchema.safeParse(
    JSON.parse(readFileSync(paths.statePath, "utf8")) as unknown,
  );
  if (!parsedState.success) {
    error(
      `samospec: state.json at ${paths.statePath} is malformed: ` +
        `${parsedState.error.message}`,
    );
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${errLines.join("\n")}\n`,
      roundsRun: 0,
    };
  }
  const state: State = parsedState.data;

  if (state.round_state === "lead_terminal") {
    error(
      `samospec: spec '${input.slug}' is at lead_terminal. ` +
        `Edit .samo/spec/${input.slug}/ manually to continue.`,
    );
    return {
      exitCode: 4,
      stdout: "",
      stderr: `${errLines.join("\n")}\n`,
      roundsRun: 0,
    };
  }

  if (!existsSync(paths.specPath)) {
    error(
      `samospec: SPEC.md for '${input.slug}' is missing — run \`samospec resume ${input.slug}\` first.`,
    );
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${errLines.join("\n")}\n`,
      roundsRun: 0,
    };
  }

  // Acquire lock for the duration of the loop.
  let handle: LockHandle;
  try {
    handle = acquireLock({
      lockPath: paths.lockPath,
      slug: input.slug,
      now: Date.parse(input.now),
      maxWallClockMinutes:
        input.maxWallClockMinutes ?? DEFAULT_MAX_WALL_CLOCK_MIN,
      pid: input.pid ?? process.pid,
    });
  } catch (err) {
    if (err instanceof LockContendedError) {
      error(
        `samospec: another samospec run holds the repo lock (pid ${err.holderPid}). ` +
          `Wait for it to exit or remove ${err.lockPath} if stale.`,
      );
      return {
        exitCode: 2,
        stdout: "",
        stderr: `${errLines.join("\n")}\n`,
        roundsRun: 0,
      };
    }
    throw err;
  }

  try {
    const maxRounds = input.maxRounds ?? DEFAULT_MAX_ROUNDS;
    // Issue #92: revise timeout precedence: explicit callTimeouts.revise_ms
    // (test injection / caller override) > budget.max_revise_call_ms in
    // .samo/config.json > SPEC §7 default (REVISE_TIMEOUT_MS, 600s).
    // The per-call cap applies to BOTH the first revise attempt and the
    // whole-round retry (see src/loop/round.ts).
    const configuredReviseMs = readReviseTimeoutFromConfig(input.cwd);
    const callTimeouts: CallTimeoutsMs = {
      criticA_ms: input.callTimeouts?.criticA_ms ?? CRITIQUE_TIMEOUT_MS,
      criticB_ms: input.callTimeouts?.criticB_ms ?? CRITIQUE_TIMEOUT_MS,
      revise_ms:
        input.callTimeouts?.revise_ms ??
        configuredReviseMs ??
        REVISE_TIMEOUT_MS,
    };
    const wallClockBudget = input.maxWallClockMs ?? DEFAULT_WALL_CLOCK_MS;
    const sessionStartedMs = input.sessionStartedAtMs ?? Date.parse(input.now);
    const nowMsFn = (): number => input.nowMs ?? Date.now();

    // Issue #91: session wall-clock guard. The live-repro showed a
    // stuck revise at round 7 running 1h 41m under a 40-min cap; this
    // deadline preempts any round (or seat call) that runs past the
    // cap. Uses a real wall clock (`Date.now()`) — cannot be silenced
    // by tests that freeze `input.nowMs`, so the hanging-adapter tests
    // in `tests/cli/iterate-wall-clock.test.ts` actually preempt.
    const sessionWallClockStartMs = Date.now();
    const sessionWallClockLimitMs = resolveSessionWallClockMs(input);

    // Initial state tracking.
    let currentState: State = state;
    let currentSpec: string = readFileSync(paths.specPath, "utf8");
    // SPEC §8 — session-scoped push-consent snapshot. `null` means "not
    // yet resolved this session"; once resolved it's respected silently
    // across the remaining round boundaries. The value here mirrors
    // persisted state when present, or the prompt answer otherwise.
    let pushGrantedThisSession: boolean | null = null;
    // SPEC §12 conditions 3 + 4 require round-(N-1) signals. The
    // classifier's "previous" is only a real round when
    // `hasPreviousRound === true`; round 1 passes synthetic signals
    // that cannot match, so neither convergence nor repeat-findings
    // can fire at round 1.
    let previousFindings: readonly Finding[] = [];
    let previousDiff = 0;
    let previousNonSummary = 0;
    let hasPreviousRound = false;
    let roundsRun = 0;
    let promptedDegradedThisSession = false;
    let sigintReceived = false;

    // SIGINT handler (SPEC §12 condition 5).
    const sigintHandler = (): void => {
      sigintReceived = true;
    };
    if (input.sigintSignal?.triggered === true) {
      sigintReceived = true;
    }
    process.on("SIGINT", sigintHandler);

    try {
      // Read prior decisions off decisions.md trailer if present. The
      // lead uses decisions_history to maintain cross-round continuity.
      const decisionsHistory: ReviewDecision[] = [];
      let manualEditDirective: string | undefined;

      while (true) {
        roundsRun += 1;
        const roundIndex = currentState.round_index + 1; // 1-based
        manualEditDirective = undefined;

        // Wall-clock guard BEFORE the round starts.
        const wallClockOk = shouldStartNextRound(
          {
            session_started_at_ms: sessionStartedMs,
            now_ms: nowMsFn(),
          },
          {
            max_wall_clock_ms: wallClockBudget,
            call_timeouts_ms: callTimeouts,
          },
        );
        if (!wallClockOk) {
          return finishIterate({
            reason: "wall-clock",
            message: stopReasonMessage("wall-clock", input.slug),
            lines,
            errLines,
            finalVersion: currentState.version,
            state: currentState,
            roundsRun: Math.max(0, roundsRun - 1),
            statePath: paths.statePath,
            tldrPath: paths.tldrPath,
            specPath: paths.specPath,
            now: input.now,
            cwd: input.cwd,
            slug: input.slug,
          });
        }

        // Issue #91: session wall-clock guard BEFORE each round starts.
        // Independent from the SPEC §11 "one more round fits" gate above
        // — this cap is the user-facing `--max-session-wall-clock-ms`
        // (or config-derived) budget, and must fire even if per-call
        // timeouts would also let another round fit.
        const sessionElapsedMs = Date.now() - sessionWallClockStartMs;
        if (sessionElapsedMs >= sessionWallClockLimitMs) {
          const leadTerm: State = {
            ...currentState,
            round_state: "lead_terminal",
            updated_at: nowIso(),
            exit: {
              code: 4,
              reason: "lead-terminal:wall_clock",
              round_index: currentState.round_index,
            },
          };
          writeState(paths.statePath, leadTerm);
          error(
            `samospec: session-wall-clock exceeded before round ` +
              `${String(roundIndex)} (${String(sessionElapsedMs)}ms ` +
              `elapsed, limit ${String(sessionWallClockLimitMs)}ms). ` +
              `Restart with a larger --max-session-wall-clock-ms or ` +
              `increase budget.max_session_wall_clock_minutes.`,
          );
          finalizeBookkeeping({
            cwd: input.cwd,
            slug: input.slug,
            statePath: paths.statePath,
            tldrPath: paths.tldrPath,
            roundIndex: leadTerm.round_index,
          });
          return {
            exitCode: 4,
            stdout: lines.join("\n"),
            stderr: `${errLines.join("\n")}\n`,
            roundsRun: Math.max(0, roundsRun - 1),
            finalVersion: currentState.version,
            stopReason: "lead-terminal",
          };
        }

        // Manual-edit detection BEFORE each round.
        const report = detectManualEdits(input.slug, {
          repoPath: input.cwd,
        });
        if (report.dirty) {
          const choice = await input.resolvers.onManualEdit(
            report.files.map((f) => f.path),
          );
          if (choice === "abort") {
            notice(
              `samospec: manual-edit abort on round ${String(roundIndex)}.`,
            );
            return finishIterate({
              reason: "sigint",
              message: "samospec: aborted after manual-edit prompt.",
              lines,
              errLines,
              finalVersion: currentState.version,
              state: currentState,
              roundsRun: Math.max(0, roundsRun - 1),
              statePath: paths.statePath,
              tldrPath: paths.tldrPath,
              specPath: paths.specPath,
              now: input.now,
              exitCodeOverride: 0,
              cwd: input.cwd,
              slug: input.slug,
            });
          }
          const outcome = applyManualEdit({
            repoPath: input.cwd,
            slug: input.slug,
            report,
            choice,
            roundNumber: roundIndex,
            now: input.now,
          });
          if (outcome.action === "committed") {
            // Re-read SPEC.md after commit.
            currentSpec = readFileSync(paths.specPath, "utf8");
            notice(
              `round ${String(roundIndex)}: committed manual edits (${choice}).`,
            );
          }
          // Lead directive from SPEC.md edits piped through to this round.
          manualEditDirective = outcome.leadDirective;
        }

        // Degraded-resolution check.
        const resSnapshot =
          input.resolutions ?? inferResolutions(input.adapters, currentState);
        const degraded = detectDegradedResolution(resSnapshot);
        if (
          (input.degradeOnFirstRound ?? true) &&
          degraded.degraded &&
          !promptedDegradedThisSession
        ) {
          promptedDegradedThisSession = true;
          const summary = formatDegradedSummary(degraded);
          notice(summary);
          const decision = await input.resolvers.onDegraded(summary);
          if (decision === "abort") {
            notice(`samospec: user aborted on degraded-resolution prompt.`);
            return finishIterate({
              reason: "sigint",
              message: "samospec: aborted at degraded-resolution prompt.",
              lines,
              errLines,
              finalVersion: currentState.version,
              state: currentState,
              roundsRun: Math.max(0, roundsRun - 1),
              statePath: paths.statePath,
              tldrPath: paths.tldrPath,
              specPath: paths.specPath,
              now: input.now,
              exitCodeOverride: 0,
              cwd: input.cwd,
              slug: input.slug,
            });
          }
        }

        // Allocate round dir.
        const dirs = roundDirsFor(
          path.join(input.cwd, ".samo", "spec", input.slug),
          roundIndex,
        );
        mkdirSync(dirs.roundDir, { recursive: true });

        // #85: thread the original idea from state.input.idea into the
        // round so Reviewer B can detect idea-contradictions and the
        // lead's revise() prompt carries the AUTHORITATIVE framing.
        const ideaForRound = state.input?.idea;

        // Issue #101: announce the round and wrap each adapter so its
        // critique/revise call emits start/complete progress lines +
        // joins the heartbeat tracker. The wrapper is per-round so
        // identities (adapter vendor + state model_id) stay fresh.
        progress.roundStart(roundIndex);
        const wrappedAdapters = wrapAdaptersForProgress(
          input.adapters,
          currentState,
          progress,
        );

        // Run the round.
        // #100: thread a wall-clock source so round.json records real
        // started_at / completed_at instead of a single frozen `now`.
        // #91: wrap the entire round in `withSessionDeadline` so a
        // hanging reviewer / lead call cannot exceed the user's
        // --max-session-wall-clock-ms cap. The per-call timeouts in
        // runRound (CRITIQUE_TIMEOUT_MS / REVISE_TIMEOUT_MS) still
        // apply inside the round; this is the outer bound.
        let roundOutcome: Awaited<ReturnType<typeof runRound>>;
        try {
          roundOutcome = await withSessionDeadline(
            runRound({
              now: input.now,
              nowFn: (): string => new Date(nowMsFn()).toISOString(),
              roundNumber: roundIndex,
              dirs,
              specText: currentSpec,
              decisionsHistory,
              adapters: wrappedAdapters,
              critiqueTimeoutMs: callTimeouts.criticA_ms,
              reviseTimeoutMs: callTimeouts.revise_ms,
              ...(manualEditDirective !== undefined
                ? { manualEditDirective }
                : {}),
              ...(ideaForRound !== undefined
                ? { idea: ideaForRound, slug: input.slug }
                : {}),
            }),
            `round_${String(roundIndex)}`,
            sessionWallClockStartMs,
            sessionWallClockLimitMs,
          );
        } catch (err) {
          if (err instanceof SessionWallClockError) {
            // #91: the cap fired mid-round. Persist a lead_terminal
            // state with a wall-clock sub-reason, scoop any untracked
            // round artefacts into a finalize commit, and surface the
            // `session-wall-clock` token in stderr so scripts can
            // pattern-match on it (matches src/cli/new.ts verbiage).
            const leadTerm: State = {
              ...currentState,
              round_state: "lead_terminal",
              round_index: roundIndex - 1,
              updated_at: nowIso(),
              exit: {
                code: 4,
                reason: "lead-terminal:wall_clock",
                round_index: roundIndex,
              },
            };
            writeState(paths.statePath, leadTerm);
            error(
              `samospec: session-wall-clock exceeded during round ` +
                `${String(roundIndex)} (${String(err.elapsedMs)}ms ` +
                `elapsed, limit ${String(err.limitMs)}ms). Restart with ` +
                `a larger --max-session-wall-clock-ms or increase ` +
                `budget.max_session_wall_clock_minutes.`,
            );
            finalizeBookkeeping({
              cwd: input.cwd,
              slug: input.slug,
              statePath: paths.statePath,
              tldrPath: paths.tldrPath,
              roundIndex: leadTerm.round_index,
              // Scoop any round-N artefacts (reviews/rNN/) created
              // before the cap tripped so the tree is clean on exit.
              // Same pattern as the existing lead_terminal branch.
              extraPaths: [dirs.roundDir],
            });
            return {
              exitCode: 4,
              stdout: lines.join("\n"),
              stderr: `${errLines.join("\n")}\n`,
              roundsRun,
              finalVersion: currentState.version,
              stopReason: "lead-terminal",
            };
          }
          throw err;
        }

        // Persist state at round boundary (round_state tracking).
        // The round started in "planned" then advanced to "running" inside
        // runRound via round.json; here we advance state.json's round_state
        // based on how the round finished.
        if (roundOutcome.roundStopReason === "lead_terminal") {
          // Route the raw lead error through the SPEC §7 sub-reason
          // classifier so refusal / schema_fail / invalid_input /
          // budget / wall_clock each surface their distinct exit-4
          // copy. Falls back to `adapter_error` when nothing matches.
          const { sub_reason, detail } = classifyLeadTerminal(
            roundOutcome.leadTerminalError ?? new Error(roundOutcome.rationale),
          );
          const leadHeadSha = resolveHeadSha(input.cwd);
          const leadTerm: State = {
            ...currentState,
            round_state: "lead_terminal",
            round_index: roundIndex - 1,
            updated_at: nowIso(),
            ...(leadHeadSha !== null ? { head_sha: leadHeadSha } : {}),
            exit: {
              code: 4,
              reason: `lead-terminal:${sub_reason}`,
              round_index: roundIndex,
            },
          };
          writeState(paths.statePath, leadTerm);
          error(formatLeadTerminalMessage(input.slug, sub_reason, detail));
          // Issue #102 — this exit path used to early-return here,
          // leaving state.json (and the untracked round-N `reviews/`
          // dir) dirty. Route it through the shared finalize-commit
          // helper so the tree is clean on every exit, including the
          // lead_terminal exit-4 path. The custom `exit.reason`
          // preserved in `leadTerm` above survives because we do not
          // go through `finishIterate` here — finishIterate would
          // overwrite `exit.reason` with the plain `"lead-terminal"`
          // enum value and drop the sub-reason detail.
          finalizeBookkeeping({
            cwd: input.cwd,
            slug: input.slug,
            statePath: paths.statePath,
            tldrPath: paths.tldrPath,
            roundIndex: leadTerm.round_index,
            // The round's reviews/ artefacts exist (reviewers ran
            // before lead.revise() threw) but no `refine` commit was
            // opened, so they are orphan-untracked. Scoop them into
            // the finalize commit so the tree is fully clean on exit.
            extraPaths: [dirs.roundDir],
          });
          return {
            exitCode: 4,
            stdout: lines.join("\n"),
            stderr: `${errLines.join("\n")}\n`,
            roundsRun,
            finalVersion: currentState.version,
            stopReason: "lead-terminal",
          };
        }

        if (
          roundOutcome.roundStopReason === "both_seats_failed_even_after_retry"
        ) {
          // Prompt the user per SPEC §7 / #6. Pass per-seat diagnostics
          // so the CLI can display error reason + message (Issue #52).
          const edA = roundOutcome.seats.reviewer_a.errorDetail;
          const edB = roundOutcome.seats.reviewer_b.errorDetail;
          const seatDiag: SeatDiagnostics = {
            reviewer_a: {
              vendor: input.adapters.reviewerA.vendor,
              ...(edA !== undefined ? { errorDetail: edA } : {}),
            },
            reviewer_b: {
              vendor: input.adapters.reviewerB.vendor,
              ...(edB !== undefined ? { errorDetail: edB } : {}),
            },
          };
          const cont = await input.resolvers.onReviewerExhausted(seatDiag);
          if (cont === "abort") {
            return finishIterate({
              reason: "reviewers-exhausted",
              message: stopReasonMessage("reviewers-exhausted", input.slug),
              lines,
              errLines,
              finalVersion: currentState.version,
              state: currentState,
              roundsRun,
              statePath: paths.statePath,
              tldrPath: paths.tldrPath,
              specPath: paths.specPath,
              now: input.now,
              cwd: input.cwd,
              slug: input.slug,
            });
          }
          // Continue with reduced reviewers isn't wired to a single-seat
          // path here — since both fell over, there's no surviving
          // critique. Halt with reviewers-exhausted regardless.
          return finishIterate({
            reason: "reviewers-exhausted",
            message: stopReasonMessage("reviewers-exhausted", input.slug),
            lines,
            errLines,
            finalVersion: currentState.version,
            state: currentState,
            roundsRun,
            statePath: paths.statePath,
            tldrPath: paths.tldrPath,
            specPath: paths.specPath,
            now: input.now,
            cwd: input.cwd,
            slug: input.slug,
          });
        }

        // Snapshot SPEC before this round's write so currentDiff below
        // compares `round-(N-1) spec` vs `round-N spec` — matches the
        // SPEC §12 condition 3 "diff between consecutive rounds".
        const preSpecForDiff = currentSpec;

        // Write spec + TLDR + decisions + changelog, bump version, commit.
        if (roundOutcome.revisedSpec !== undefined) {
          // #107: re-render the architecture block from architecture.json
          // on every round. The JSON is the source of truth; even if the
          // lead rewrote SPEC.md prose this round, the ASCII block stays
          // a deterministic function of the schema.
          const architecture = readArchitectureOrEmpty(paths.architecturePath);
          const newSpec = ensureTrailingNewline(
            injectArchitectureBlock(
              ensureTrailingNewline(roundOutcome.revisedSpec),
              architecture,
            ),
          );
          writeFileSync(paths.specPath, newSpec, "utf8");
          // TLDR is re-rendered in finishIterate once `exit` is set so
          // the Next-action section reflects convergence. Render here
          // with a provisional committed-but-not-yet-exited state so a
          // mid-loop `samospec status` sees a coherent file between
          // rounds (#96).
          const provisional: State = {
            ...currentState,
            round_state: "committed",
            round_index: roundIndex,
            exit: null,
            updated_at: nowIso(),
          };
          writeFileSync(
            paths.tldrPath,
            renderTldr(newSpec, { slug: input.slug, state: provisional }),
            "utf8",
          );

          // Decisions.
          const counts = countDecisions(roundOutcome.decisions);
          appendRoundDecisions({
            file: paths.decisionsPath,
            roundNumber: roundIndex,
            now: input.now,
            entries: roundOutcome.decisions,
          });
          // Append to decisionsHistory for next round.
          for (const d of roundOutcome.decisions) decisionsHistory.push(d);

          // Changelog entry.
          const newVersion = bumpMinor(currentState.version);
          const changelogEntry = formatChangelogEntry({
            version: newVersion,
            now: input.now,
            roundNumber: roundIndex,
            accepted: counts.accepted,
            rejected: counts.rejected,
            deferred: counts.deferred,
            ...(degraded.degraded
              ? { degradedResolution: formatDegradedSummary(degraded) }
              : {}),
            ...(roundOutcome.retried
              ? { notes: ["reviewers retried this round (SPEC §7)"] }
              : {}),
          });
          appendOrCreateChangelog(paths.changelogPath, changelogEntry);

          // State: lead_revised -> committed; bump round_index and version.
          //
          // Issue #102: `updated_at` is the wall-clock time of this
          // write, not the frozen `input.now` (which is the round-start
          // stamp). `head_sha` stays whatever it was pre-commit here —
          // we can't `git rev-parse HEAD` until AFTER the commit runs,
          // so the round commit itself contains `head_sha` for the
          // PREVIOUS round's SHA. Right after the commit we rewrite
          // state.json with the fresh SHA so the final on-disk value
          // always matches HEAD; the resulting tiny dirty window is
          // closed by either the next round's commit or the `finalize`
          // commit inside `finishIterate`.
          currentState = {
            ...currentState,
            round_state: "committed",
            round_index: roundIndex,
            version: newVersion,
            updated_at: nowIso(),
            remote_stale: currentState.remote_stale,
            coupled_fallback:
              input.resolutions?.coupled_fallback ??
              currentState.coupled_fallback,
          };
          writeState(paths.statePath, currentState);

          // Commit.
          try {
            specCommit({
              repoPath: input.cwd,
              slug: input.slug,
              action: "refine",
              version: stripPatchForCommit(newVersion),
              roundNumber: roundIndex,
              paths: [
                path.relative(input.cwd, paths.specPath),
                path.relative(input.cwd, paths.tldrPath),
                path.relative(input.cwd, paths.statePath),
                path.relative(input.cwd, paths.decisionsPath),
                path.relative(input.cwd, paths.changelogPath),
                path.relative(input.cwd, dirs.roundJson),
                // #107: include architecture.json whenever it exists,
                // so iterate rounds track schema changes in git alongside
                // SPEC.md. Older specs that predate this feature simply
                // skip this path.
                ...(existsSync(paths.architecturePath)
                  ? [path.relative(input.cwd, paths.architecturePath)]
                  : []),
                ...(existsSync(dirs.codexPath)
                  ? [path.relative(input.cwd, dirs.codexPath)]
                  : []),
                ...(existsSync(dirs.claudePath)
                  ? [path.relative(input.cwd, dirs.claudePath)]
                  : []),
              ],
            });
            notice(
              `committed spec(${input.slug}): refine ${formatVersionLabel(newVersion)} after review r${String(roundIndex).padStart(2, "0")}`,
            );

            // Issue #102 — post-commit bookkeeping write. `head_sha`
            // can only be resolved AFTER the commit is in place; do
            // the rewrite here so `state.head_sha` is accurate for
            // anything reading state.json between rounds (e.g. a
            // concurrent `samospec status`). This leaves state.json
            // temporarily dirty; the next round's `specCommit` or the
            // `finalize` commit at loop exit cleans it up.
            const postCommitSha = resolveHeadSha(input.cwd);
            if (postCommitSha !== null) {
              currentState = {
                ...currentState,
                head_sha: postCommitSha,
                updated_at: nowIso(),
              };
              writeState(paths.statePath, currentState);
            }

            // SPEC §5 Phase 6 + §8 — round-boundary push. Exactly one
            // push per `committed` transition; never per commit.
            if (input.pushOptions !== undefined) {
              const pushOutcome = await handleRoundBoundaryPush({
                cwd: input.cwd,
                slug: input.slug,
                pushOptions: input.pushOptions,
                onPushConsent: input.resolvers.onPushConsent,
                sessionGranted: pushGrantedThisSession,
                now: input.now,
              });
              if (pushOutcome.kind === "interrupt") {
                const interrupted: State = {
                  ...currentState,
                  updated_at: nowIso(),
                  exit: {
                    code: 3,
                    reason: "push-consent-interrupted",
                    round_index: roundIndex,
                  },
                };
                writeState(paths.statePath, interrupted);
                error(`samospec: push-consent prompt interrupted (Ctrl-C).`);
                // Issue #102 — same class of bug as the lead_terminal
                // path: this early-return wrote state.json without
                // opening a finalize commit, leaving the tree dirty.
                // Route through the shared helper.
                finalizeBookkeeping({
                  cwd: input.cwd,
                  slug: input.slug,
                  statePath: paths.statePath,
                  tldrPath: paths.tldrPath,
                  roundIndex,
                });
                return {
                  exitCode: 3,
                  stdout: lines.join("\n"),
                  stderr: `${errLines.join("\n")}\n`,
                  roundsRun,
                  finalVersion: currentState.version,
                };
              }
              if (pushOutcome.sessionGranted !== undefined) {
                pushGrantedThisSession = pushOutcome.sessionGranted;
              }
              if (pushOutcome.pushResult !== undefined) {
                emitPushNotice(
                  notice,
                  error,
                  pushOutcome.pushResult,
                  input.pushOptions.remote,
                );
              }
            }
          } catch (err) {
            if (err instanceof ProtectedBranchError) {
              error(
                `samospec: cannot commit on protected branch '${err.branchName}'. ` +
                  `Check out samospec/${input.slug} and re-run.`,
              );
              return {
                exitCode: 2,
                stdout: lines.join("\n"),
                stderr: `${errLines.join("\n")}\n`,
                roundsRun,
                finalVersion: currentState.version,
              };
            }
            throw err;
          }

          // NOTE: do NOT overwrite `previousDiff` / `previousNonSummary`
          // / `previousFindings` here. The classifier below needs
          // round-(N-1)'s signals as `previous` and round-N's as
          // `current`. We update the "previous" pointers AFTER the
          // classifier runs, so the NEXT iteration sees this round's
          // values as its "previous". SPEC §12 conditions 3 + 4 both
          // require N-vs-(N-1) comparisons; reassigning early made them
          // collapse into N-vs-N (spurious halt on round 1). Bug fixed
          // in response to PR #30 REV review.
          currentSpec = newSpec;
        }

        // Compute THIS round's signals for the classifier. Must stay
        // separate from the `previous…` pointers until after classify.
        const currentFindings: readonly Finding[] = [
          ...(roundOutcome.seats.reviewer_a.critique?.findings ?? []),
          ...(roundOutcome.seats.reviewer_b.critique?.findings ?? []),
        ];
        const currentDiff =
          roundOutcome.revisedSpec !== undefined
            ? countDiffLines(preSpecForDiff, currentSpec)
            : 0;
        const currentNonSummary =
          countNonSummaryCategoriesWithFindings(currentFindings);

        // SPEC §12 conditions 3 + 4 require TWO consecutive rounds. On
        // round 1 there is no previous round, so we must neither trip
        // convergence nor trip repeat-findings. The classifier's
        // `previous.findings = []` already self-gates repeat-findings
        // (no previous categories → `no_previous_findings`). For
        // convergence we pass synthetic "previous" signals that cannot
        // match (large diff, one non-summary finding) when
        // `hasPreviousRound` is false.
        const previousForClassifier = hasPreviousRound
          ? {
              findings: previousFindings,
              diffLines: previousDiff,
              nonSummaryCategoriesWithFindings: previousNonSummary,
            }
          : {
              findings: [] as readonly Finding[],
              diffLines: Number.MAX_SAFE_INTEGER,
              nonSummaryCategoriesWithFindings: Number.MAX_SAFE_INTEGER,
            };
        const stop = classifyAllStops({
          currentRoundIndex: roundIndex,
          maxRounds,
          leadReady: roundOutcome.ready,
          previous: previousForClassifier,
          current: {
            findings: currentFindings,
            diffLines: currentDiff,
            nonSummaryCategoriesWithFindings: currentNonSummary,
          },
          reviewerAvailability:
            (roundOutcome.seats.reviewer_a.state === "ok" ? 1 : 0) +
            (roundOutcome.seats.reviewer_b.state === "ok" ? 1 : 0),
          wallClockOk: true,
          budgetOk: true,
          leadTerminal: false,
          sigintReceived,
        });

        if (stop.suggestDownshift) {
          notice(
            "samospec: consider `--effort high` — two consecutive low-delta rounds.",
          );
        }

        if (stop.stop) {
          const reason = stop.reason ?? "max-rounds";
          return finishIterate({
            reason,
            message: stopReasonMessage(reason, input.slug),
            lines,
            errLines,
            finalVersion: currentState.version,
            state: currentState,
            roundsRun,
            statePath: paths.statePath,
            tldrPath: paths.tldrPath,
            specPath: paths.specPath,
            now: input.now,
            cwd: input.cwd,
            slug: input.slug,
          });
        }

        // Classifier is done for this round; now roll THIS round's
        // signals into the "previous" pointers for the NEXT round.
        // Doing this AFTER classify is what makes SPEC §12 conditions
        // 3 + 4 compare round-N vs round-(N-1) instead of N vs N.
        previousFindings = currentFindings;
        previousDiff = currentDiff;
        previousNonSummary = currentNonSummary;
        hasPreviousRound = true;
      }
    } finally {
      process.off("SIGINT", sigintHandler);
    }
  } finally {
    releaseLock(handle);
    // Issue #101: always tear down the heartbeat timer so a stray
    // setInterval doesn't keep the process alive past `iterate`.
    progress.shutdown();
  }
}

// ---------- helpers ----------

// ---------- session wall-clock guard (#91) ----------

/**
 * Thrown by `withSessionDeadline()` when the iterate session wall-clock
 * cap is exceeded. Mirrors `SessionWallClockError` in `src/cli/new.ts`
 * so both subcommands surface the same `session-wall-clock` token in
 * stderr and exit with code 4.
 */
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
 * If the deadline fires first, throws `SessionWallClockError`. Used at
 * every seat call and between rounds so a hanging reviewer cannot run
 * past the cap (see #91 live-repro: 40 min cap, 1h 41m runtime).
 */
async function withSessionDeadline<T>(
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
 * Resolve the session wall-clock limit (ms) for `runIterate`:
 *   1. `input.maxSessionWallClockMs` (explicit override, e.g. from
 *      `--max-session-wall-clock-ms <ms>` on the CLI).
 *   2. `budget.max_session_wall_clock_minutes` in `.samo/config.json`.
 *   3. `DEFAULT_SESSION_WALL_CLOCK_MS` (10 min).
 *
 * Kept local to `iterate.ts` so changes to `new.ts`'s config layout
 * cannot silently mutate iterate's cap; the two subcommands share the
 * same schema but resolve it independently.
 */
function resolveSessionWallClockMs(input: IterateInput): number {
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

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

/**
 * Issue #102 — wall-clock ISO stamp for every `state.updated_at` write.
 * The bug report called out that iterate was re-using a frozen round-
 * start timestamp across the whole session; this helper centralises the
 * `Date.now()` call so no writer can skip the bump.
 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Issue #102 — resolve the current branch HEAD sha to populate
 * `state.head_sha`. Returns `null` when the repo has no HEAD yet
 * (unborn branch) so we never write a malformed value.
 */
function resolveHeadSha(cwd: string): string | null {
  const res = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if ((res.status ?? 1) !== 0) return null;
  const sha = (res.stdout ?? "").trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * Issue #102 — `git status --porcelain -- <paths>` to decide whether a
 * follow-up `finalize` commit has anything to include. Returns the list
 * of paths (relative to `cwd`) that git reports as modified / added /
 * deleted. An empty list means the tree is already clean — skip the
 * finalize commit entirely.
 */
function dirtyPaths(cwd: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const res = spawnSync("git", ["status", "--porcelain", "--", ...paths], {
    cwd,
    encoding: "utf8",
  });
  if ((res.status ?? 1) !== 0) return [];
  const out = res.stdout ?? "";
  const result: string[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    // Porcelain v1 format: "XY <path>" (two status chars + space + path).
    const p = line.slice(3);
    if (p.length > 0) result.push(p);
  }
  return result;
}

/**
 * Issue #102 — open a `spec(<slug>): finalize round N` commit for the
 * post-round bookkeeping write so `state.json` (and often `TLDR.md`)
 * don't linger in the working tree as dirty paths. Shared by the
 * `finishIterate` tail AND the `lead_terminal` early-return path so
 * exit-4 runs leave a clean tree too.
 *
 * Guards:
 *  - Skip when `cwd`/`slug` are absent (synthetic unit tests).
 *  - Skip on protected branches — the round-loop already refused to
 *    commit there, so we must not commit either.
 *  - Skip when the tracked bookkeeping paths are already clean (no
 *    empty commits ever).
 *
 * Best-effort: any thrown error is swallowed. The state.json write that
 * must precede this call has already succeeded; worst case the next
 * `iterate` run sees a dirty tree and prompts on it — strictly a
 * non-regression from pre-#102 behaviour.
 *
 * After this commit `git rev-parse HEAD` advances by one. The on-disk
 * `state.head_sha` therefore points to HEAD~1 (the round's `refine`
 * content commit), not HEAD itself. That is intentional: a commit
 * cannot name itself in its own tree. `verifyHeadSha` callers must be
 * ready to accept HEAD~1 when the branch's tip is a `finalize`
 * bookkeeping commit — see the PR body for the trade-off.
 */
function finalizeBookkeeping(args: {
  readonly cwd: string | undefined;
  readonly slug: string | undefined;
  readonly statePath: string;
  readonly tldrPath: string | undefined;
  readonly roundIndex: number;
  /**
   * Extra absolute paths to include when checking for dirty state.
   * The `lead_terminal` exit passes the current round's `reviews/rNN/`
   * artefacts so they are scooped into the finalize commit instead of
   * being left as an untracked directory. Empty in the happy-path
   * caller because `specCommit(..., "refine", ...)` already covered
   * those files.
   */
  readonly extraPaths?: readonly string[];
}): void {
  if (args.cwd === undefined || args.slug === undefined) return;
  try {
    const branch = currentBranch(args.cwd);
    if (isProtected(branch, { repoPath: args.cwd })) return;
    const candidatePaths: string[] = [path.relative(args.cwd, args.statePath)];
    if (args.tldrPath !== undefined && existsSync(args.tldrPath)) {
      candidatePaths.push(path.relative(args.cwd, args.tldrPath));
    }
    if (args.extraPaths !== undefined) {
      for (const p of args.extraPaths) {
        if (existsSync(p)) candidatePaths.push(path.relative(args.cwd, p));
      }
    }
    const dirty = dirtyPaths(args.cwd, candidatePaths);
    if (dirty.length === 0) return;
    specCommit({
      repoPath: args.cwd,
      slug: args.slug,
      action: "finalize",
      roundNumber: args.roundIndex,
      paths: dirty,
    });
  } catch {
    // Best-effort — see docstring.
  }
}

// ---------- round-boundary push plumbing (SPEC §5 Phase 6 + §8) ----------

interface HandlePushArgs {
  readonly cwd: string;
  readonly slug: string;
  readonly pushOptions: PushOptions;
  readonly onPushConsent: PushConsentResolver | undefined;
  readonly sessionGranted: boolean | null;
  readonly now: string;
}

interface PushResult {
  readonly kind: "ok" | "interrupt";
  /** Set when a decision was reached; propagates to the next round. */
  readonly sessionGranted?: boolean;
  readonly pushResult?: PushBranchResult;
}

/**
 * Coordinate consent + push at a single round boundary. Returns
 * `kind: "interrupt"` when the user Ctrl-C'd the consent prompt so
 * the caller can emit exit 3 per SPEC §10. Otherwise returns a
 * `pushResult` the caller can surface via notice/error.
 *
 * Idempotency: once the session has resolved consent (granted or
 * refused), this short-circuits on subsequent rounds without calling
 * the resolver again. Persisted choices on disk short-circuit the same
 * way — the resolver is invoked at most once per session.
 */
async function handleRoundBoundaryPush(
  args: HandlePushArgs,
): Promise<PushResult> {
  // `--no-push` invocation override: never pushes, never prompts. Beats
  // persisted-accept and session-accept alike.
  if (args.pushOptions.noPush) {
    return {
      kind: "ok",
      ...(args.sessionGranted !== null
        ? { sessionGranted: args.sessionGranted }
        : {}),
      pushResult: pushBranchSafely({
        repoPath: args.cwd,
        remote: args.pushOptions.remote,
        branch: currentBranch(args.cwd),
        granted: true,
        noPush: true,
      }),
    };
  }

  const branch = currentBranch(args.cwd);
  const remoteUrl = resolveRemoteUrl(args.cwd, args.pushOptions.remote);
  if (remoteUrl === null) {
    // Remote not configured — skip silently, like a refused consent.
    return { kind: "ok" };
  }

  let granted: boolean;
  let sessionGranted: boolean | undefined;
  if (args.sessionGranted !== null) {
    granted = args.sessionGranted;
    sessionGranted = args.sessionGranted;
  } else {
    const resolver = args.onPushConsent;
    const defaultBranch = resolveDefaultBranch(
      args.cwd,
      args.pushOptions.remote,
    );
    const capability = probePrCapability();
    const outcome = await requestPushConsent({
      repoPath: args.cwd,
      remoteName: args.pushOptions.remote,
      remoteUrl,
      targetBranch: branch,
      defaultBranch,
      prCapability: capability,
      prompt:
        resolver ??
        ((): Promise<PushConsentDecision> => Promise.resolve("refuse")),
    });
    if (outcome.decision === "interrupt") {
      return { kind: "interrupt" };
    }
    granted = outcome.decision === "accept";
    sessionGranted = granted;
  }

  const pushResult = pushBranchSafely({
    repoPath: args.cwd,
    remote: args.pushOptions.remote,
    branch,
    granted,
    noPush: false,
  });
  return {
    kind: "ok",
    ...(sessionGranted !== undefined ? { sessionGranted } : {}),
    pushResult,
  };
}

function pushBranchSafely(args: {
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

function resolveRemoteUrl(cwd: string, remoteName: string): string | null {
  const res = spawnSync("git", ["remote", "get-url", remoteName], {
    cwd,
    encoding: "utf8",
  });
  if ((res.status ?? 1) !== 0) return null;
  const url = (res.stdout ?? "").trim();
  return url.length > 0 ? url : null;
}

function resolveDefaultBranch(cwd: string, remoteName: string): string {
  // `git symbolic-ref refs/remotes/<remote>/HEAD` → `refs/remotes/<remote>/<name>`
  const head = spawnSync(
    "git",
    ["symbolic-ref", "--quiet", `refs/remotes/${remoteName}/HEAD`],
    { cwd, encoding: "utf8" },
  );
  if ((head.status ?? 1) === 0) {
    const ref = (head.stdout ?? "").trim();
    const prefix = `refs/remotes/${remoteName}/`;
    if (ref.startsWith(prefix)) {
      return ref.slice(prefix.length);
    }
  }
  // Fallback to the local config `init.defaultBranch`, then `main`.
  const cfg = spawnSync("git", ["config", "--get", "init.defaultBranch"], {
    cwd,
    encoding: "utf8",
  });
  if ((cfg.status ?? 1) === 0) {
    const value = (cfg.stdout ?? "").trim();
    if (value.length > 0) return value;
  }
  return "main";
}

function emitPushNotice(
  notice: (line: string) => void,
  error: (line: string) => void,
  result: PushBranchResult,
  remote: string,
): void {
  switch (result.state) {
    case "pushed":
      notice(`pushed to ${remote}.`);
      return;
    case "skipped-no-push":
      notice(`push skipped (--no-push).`);
      return;
    case "skipped-refused":
      notice(`push skipped (consent refused).`);
      return;
    case "failed":
      error(
        `samospec: push to ${remote} failed: ${
          result.message ?? "(no detail)"
        }`,
      );
      return;
    default: {
      // Exhaustiveness check; unreachable.
      const _never: never = result.state;
      void _never;
    }
  }
}

function appendOrCreateChangelog(filePath: string, entry: string): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, `# changelog\n\n${entry}`, "utf8");
    return;
  }
  // Append to end.
  const existing = readFileSync(filePath, "utf8");
  const joiner = existing.endsWith("\n") ? "" : "\n";
  writeFileSync(filePath, existing + joiner + entry, "utf8");
}

function stripPatchForCommit(semver: string): string {
  const m = /^(\d+)\.(\d+)\.0$/.exec(semver);
  if (m !== null) {
    return `${m[1] ?? "0"}.${m[2] ?? "0"}`;
  }
  return semver;
}

function inferResolutions(
  adapters: IterateInput["adapters"],
  state: State,
): {
  readonly lead: AdapterResolutionSnapshot;
  readonly reviewer_a: AdapterResolutionSnapshot;
  readonly reviewer_b: AdapterResolutionSnapshot;
  readonly coupled_fallback: boolean;
} {
  const stateAdapters = state.adapters ?? {};
  return {
    lead: {
      adapter: adapters.lead.vendor,
      model_id: stateAdapters.lead?.model_id ?? "claude-opus-4-7",
    },
    reviewer_a: {
      adapter: adapters.reviewerA.vendor,
      model_id: stateAdapters.reviewer_a?.model_id ?? "gpt-5.1-codex-max",
    },
    reviewer_b: {
      adapter: adapters.reviewerB.vendor,
      model_id: stateAdapters.reviewer_b?.model_id ?? "claude-opus-4-7",
    },
    coupled_fallback: state.coupled_fallback,
  };
}

interface FinishArgs {
  readonly reason: StopReason;
  readonly message: string;
  readonly lines: string[];
  readonly errLines: string[];
  readonly finalVersion: string;
  readonly state: State;
  readonly roundsRun: number;
  readonly statePath: string;
  readonly now: string;
  readonly exitCodeOverride?: number;
  /** Optional — when set, TLDR.md is re-rendered with the final state
   *  so its Next-action section reflects the exit reason (#96). */
  readonly tldrPath?: string;
  readonly specPath?: string;
  /** Issue #102 — repo cwd + slug so `finishIterate` can open a small
   *  `spec(<slug>): finalize round N` commit for the post-round
   *  bookkeeping write. Absent in a few synthetic test paths; when
   *  omitted the finalize commit is skipped safely. */
  readonly cwd?: string;
  readonly slug?: string;
}

function finishIterate(args: FinishArgs): IterateResult {
  const exitCode = args.exitCodeOverride ?? stopReasonExitCode(args.reason);

  // Issue #102 — resolve HEAD before writing so `state.head_sha` tracks
  // the commit that iterate produced for this session. A `null` result
  // (unborn branch, missing cwd) falls back to whatever `state.head_sha`
  // already holds, so we never regress a previously-recorded sha.
  let headShaForFinal: string | null | undefined;
  if (args.cwd !== undefined) {
    const resolved = resolveHeadSha(args.cwd);
    if (resolved !== null) headShaForFinal = resolved;
  }

  const withExit: State = {
    ...args.state,
    exit: {
      code: exitCode,
      reason: args.reason,
      round_index: args.state.round_index,
    },
    // Issue #102 — wall-clock, not the frozen `input.now` round-start
    // stamp. The `args.now` param is kept in the interface for any
    // remaining non-stamp uses (none today); we deliberately ignore it
    // for the `updated_at` field so every write lands a fresh time.
    updated_at: nowIso(),
    ...(headShaForFinal !== undefined ? { head_sha: headShaForFinal } : {}),
  };
  writeState(args.statePath, withExit);

  // Re-render TLDR.md so its Next-action section matches the exit
  // reason (#96). Guarded by tldrPath/specPath presence and existence
  // checks so the unit tests that feed a synthetic state without a
  // tldr file on disk still work.
  if (
    args.tldrPath !== undefined &&
    args.specPath !== undefined &&
    existsSync(args.specPath) &&
    existsSync(args.tldrPath)
  ) {
    const spec = readFileSync(args.specPath, "utf8");
    writeFileSync(
      args.tldrPath,
      renderTldr(spec, { slug: withExit.slug, state: withExit }),
      "utf8",
    );
  }

  finalizeBookkeeping({
    cwd: args.cwd,
    slug: args.slug,
    statePath: args.statePath,
    tldrPath: args.tldrPath,
    roundIndex: withExit.round_index,
  });

  const stream = exitCode === 0 ? args.lines : args.errLines;
  stream.push(args.message);

  // Next-step hint (#71 + #96). Single shared helper so iterate's
  // stdout tail never disagrees with `samospec status` or TLDR.md.
  args.lines.push(`next: ${computeNextAction(withExit, withExit.slug)}`);

  return {
    exitCode,
    stdout: args.lines.length === 0 ? "" : `${args.lines.join("\n")}\n`,
    stderr: args.errLines.length === 0 ? "" : `${args.errLines.join("\n")}\n`,
    roundsRun: args.roundsRun,
    finalVersion: args.finalVersion,
    stopReason: args.reason,
  };
}

// Used by tests: re-read decisions.md into something structured.
export function readDecisions(file: string): string {
  return readDecisionsFile(file);
}

// ---------- progress wrapping (#101) ----------

/**
 * Build progress-aware proxies around the real adapters. Each proxy
 * forwards the call to its underlying adapter but also:
 *   - emits a "<role> starting" line before the call
 *   - joins the heartbeat tracker for the duration of the call
 *   - emits a "<role> complete (Xs, ...)" line after the call resolves
 *
 * The proxy is fully transparent in behaviour — same return values,
 * same error propagation — so `runRound`'s retry / partial-failure
 * paths stay untouched. Identity strings are derived from the
 * adapter's `vendor` + the state's persisted `adapters.<role>.model_id`
 * when available, falling back to `vendor` alone.
 *
 * Prototype preservation: real adapters (ClaudeAdapter, CodexAdapter)
 * are class instances whose methods live on the prototype, not the
 * instance. `{...adapter}` spread only copies own enumerable
 * properties, so `detect()`, `models()`, `ask()`, `supports_*` etc.
 * would silently disappear. We use `Object.create(proto)` to preserve
 * the original class's prototype chain — `instanceof OriginalClass`
 * continues to hold, every inherited method remains callable, and
 * only `critique`/`revise` are overridden as own properties on the
 * wrapper.
 */
export function wrapAdaptersForProgress(
  adapters: IterateInput["adapters"],
  state: State,
  progress: ProgressReporter,
): IterateInput["adapters"] {
  const stateAdapters = state.adapters ?? {};
  const leadIdentity = stateAdapters.lead?.model_id ?? adapters.lead.vendor;
  const reviewerAIdentity =
    stateAdapters.reviewer_a?.model_id ?? adapters.reviewerA.vendor;
  const reviewerBIdentity =
    stateAdapters.reviewer_b?.model_id ?? adapters.reviewerB.vendor;

  const wrappedLead = cloneWithPrototype(adapters.lead);
  wrappedLead.revise = async (input) => {
    const handle = progress.beginLead(leadIdentity);
    try {
      const out = await adapters.lead.revise(input);
      handle.complete(undefined);
      return out;
    } catch (err) {
      handle.abort();
      throw err;
    }
  };

  const wrappedReviewerA = cloneWithPrototype(adapters.reviewerA);
  wrappedReviewerA.critique = async (input) => {
    const handle = progress.beginReviewer("reviewer_a", reviewerAIdentity);
    try {
      const out = await adapters.reviewerA.critique(input);
      handle.complete({ findings: out.findings.length });
      return out;
    } catch (err) {
      handle.abort();
      throw err;
    }
  };

  const wrappedReviewerB = cloneWithPrototype(adapters.reviewerB);
  wrappedReviewerB.critique = async (input) => {
    const handle = progress.beginReviewer("reviewer_b", reviewerBIdentity);
    try {
      const out = await adapters.reviewerB.critique(input);
      handle.complete({ findings: out.findings.length });
      return out;
    } catch (err) {
      handle.abort();
      throw err;
    }
  };

  return {
    lead: wrappedLead,
    reviewerA: wrappedReviewerA,
    reviewerB: wrappedReviewerB,
  };
}

/**
 * Produce a prototype-preserving clone of `source` so that a caller
 * can override selected methods as own properties without dropping
 * any of the inherited class methods. The result satisfies
 * `instanceof source.constructor` and delegates every non-overridden
 * method through the prototype chain.
 */
function cloneWithPrototype<T extends object>(source: T): T {
  const clone = Object.create(Object.getPrototypeOf(source) as object) as T;
  // Copy own enumerable properties (e.g. `vendor` set via `this.vendor = ...`
  // in the constructor). Prototype methods are reached via the prototype
  // chain so we never copy them explicitly.
  Object.assign(clone, source);
  return clone;
}

/**
 * Issue #92 — read `budget.max_revise_call_ms` from `.samo/config.json`.
 * Returns the configured ms when the file is present and the key is a
 * positive integer, otherwise `undefined` so the caller falls back to
 * `REVISE_TIMEOUT_MS`. Best-effort: any read/parse error returns
 * `undefined` silently — the round runner's own default covers us.
 */
function readReviseTimeoutFromConfig(cwd: string): number | undefined {
  try {
    const configPath = path.join(cwd, ".samo", "config.json");
    if (!existsSync(configPath)) return undefined;
    const raw = readFileSync(configPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const budget = (parsed as Record<string, unknown>)["budget"];
    if (typeof budget !== "object" || budget === null) return undefined;
    const v = (budget as Record<string, unknown>)["max_revise_call_ms"];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return undefined;
    }
    return Math.floor(v);
  } catch {
    return undefined;
  }
}
