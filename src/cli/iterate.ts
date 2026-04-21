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
import { renderTldr } from "../render/tldr.ts";
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

// ---------- constants ----------

const DEFAULT_MAX_ROUNDS = 10 as const;
const DEFAULT_WALL_CLOCK_MS = 240 * 60 * 1000; // 240 minutes
const DEFAULT_MAX_WALL_CLOCK_MIN = 240;

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
    const callTimeouts: CallTimeoutsMs = {
      criticA_ms: input.callTimeouts?.criticA_ms ?? CRITIQUE_TIMEOUT_MS,
      criticB_ms: input.callTimeouts?.criticB_ms ?? CRITIQUE_TIMEOUT_MS,
      revise_ms: input.callTimeouts?.revise_ms ?? REVISE_TIMEOUT_MS,
    };
    const wallClockBudget = input.maxWallClockMs ?? DEFAULT_WALL_CLOCK_MS;
    const sessionStartedMs = input.sessionStartedAtMs ?? Date.parse(input.now);
    const nowMsFn = (): number => input.nowMs ?? Date.now();

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
          });
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

        // Run the round.
        const roundOutcome = await runRound({
          now: input.now,
          roundNumber: roundIndex,
          dirs,
          specText: currentSpec,
          decisionsHistory,
          adapters: input.adapters,
          critiqueTimeoutMs: callTimeouts.criticA_ms,
          reviseTimeoutMs: callTimeouts.revise_ms,
          ...(manualEditDirective !== undefined ? { manualEditDirective } : {}),
          ...(ideaForRound !== undefined
            ? { idea: ideaForRound, slug: input.slug }
            : {}),
        });

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
          const leadTerm: State = {
            ...currentState,
            round_state: "lead_terminal",
            round_index: roundIndex - 1,
            updated_at: input.now,
            exit: {
              code: 4,
              reason: `lead-terminal:${sub_reason}`,
              round_index: roundIndex,
            },
          };
          writeState(paths.statePath, leadTerm);
          error(formatLeadTerminalMessage(input.slug, sub_reason, detail));
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
          });
        }

        // Snapshot SPEC before this round's write so currentDiff below
        // compares `round-(N-1) spec` vs `round-N spec` — matches the
        // SPEC §12 condition 3 "diff between consecutive rounds".
        const preSpecForDiff = currentSpec;

        // Write spec + TLDR + decisions + changelog, bump version, commit.
        if (roundOutcome.revisedSpec !== undefined) {
          const newSpec = ensureTrailingNewline(roundOutcome.revisedSpec);
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
            updated_at: input.now,
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
          currentState = {
            ...currentState,
            round_state: "committed",
            round_index: roundIndex,
            version: newVersion,
            updated_at: input.now,
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
                  updated_at: input.now,
                  exit: {
                    code: 3,
                    reason: "push-consent-interrupted",
                    round_index: roundIndex,
                  },
                };
                writeState(paths.statePath, interrupted);
                error(`samospec: push-consent prompt interrupted (Ctrl-C).`);
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
  }
}

// ---------- helpers ----------

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
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
}

function finishIterate(args: FinishArgs): IterateResult {
  const exitCode = args.exitCodeOverride ?? stopReasonExitCode(args.reason);
  const withExit: State = {
    ...args.state,
    exit: {
      code: exitCode,
      reason: args.reason,
      round_index: args.state.round_index,
    },
    updated_at: args.now,
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
