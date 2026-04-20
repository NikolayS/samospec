// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §10 `samospec iterate` — multi-round review loop.
 *
 * Default: run rounds until a stopping condition fires. `--rounds N`
 * caps for this invocation.
 *
 * Preconditions:
 *   - `.samospec/spec/<slug>/state.json` exists (exit 1 otherwise with
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Adapter, Finding } from "../adapter/types.ts";
import { specCommit } from "../git/commit.ts";
import { ProtectedBranchError } from "../git/errors.ts";
import {
  applyManualEdit,
  detectManualEdits,
  type ManualEditChoice,
} from "../git/manual-edit.ts";
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
export type ContinueReviewersResolver = () => Promise<ContinueReviewersChoice>;

export interface IterateResolvers {
  readonly onManualEdit: ManualEditResolver;
  readonly onDegraded: DegradeResolver;
  readonly onReviewerExhausted: ContinueReviewersResolver;
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
        `Edit .samospec/spec/${input.slug}/ manually to continue.`,
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
              now: input.now,
              exitCodeOverride: 0,
            });
          }
        }

        // Allocate round dir.
        const dirs = roundDirsFor(
          path.join(input.cwd, ".samospec", "spec", input.slug),
          roundIndex,
        );
        mkdirSync(dirs.roundDir, { recursive: true });

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
          // Prompt the user per SPEC §7 / #6.
          const cont = await input.resolvers.onReviewerExhausted();
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
          writeFileSync(
            paths.tldrPath,
            renderTldr(newSpec, { slug: input.slug }),
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
  const stream = exitCode === 0 ? args.lines : args.errLines;
  stream.push(args.message);
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
