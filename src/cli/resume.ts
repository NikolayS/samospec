// Copyright 2026 Nikolay Samokhvalov.

// SPEC §5 + §7 — `samospec resume [<slug>]`.
//
// Phase-based resumption covering every boundary Issue #15 wires:
//
//   - no state.json        -> exit 1 with remediation.
//   - round_state ===
//     lead_terminal        -> exit 4, specific copy (absorbing per §7).
//   - persona missing      -> exit 1, suggest re-running `samospec new`.
//   - persona present,
//     interview missing    -> re-enter interview, write interview.json,
//                             then continue into the draft below.
//   - persona + interview
//     present, SPEC.md
//     missing              -> re-run the draft via revise(), write the
//                             committed artifacts, commit if we are on
//                             samospec/<slug>.
//   - phase === draft +
//     round_state ===
//     committed (v0.1)     -> print iterate hint and exit 0.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Adapter } from "../adapter/types.ts";
import { discoverContext } from "../context/discover.ts";
import { contextJsonPath, writeContextJson } from "../context/provenance.ts";
import { specCommit } from "../git/commit.ts";
import { ProtectedBranchError } from "../git/errors.ts";
import { writeCalibrationSample } from "../policy/calibration.ts";
import { renderTldr } from "../render/tldr.ts";
import {
  LockContendedError,
  acquireLock,
  releaseLock,
  type LockHandle,
} from "../state/lock.ts";
import { advancePhase } from "../state/phase.ts";
import { writeState } from "../state/store.ts";
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
} from "./interview.ts";
import { inspectSpec, specPaths, type ChoiceResolvers } from "./new.ts";
import { PERSONA_FORM_RE, formatPersonaString } from "./persona.ts";

const DEFAULT_MAX_WALL_CLOCK_MIN = 240;
const V01_VERSION = "0.1.0" as const;

export interface RunResumeInput {
  readonly cwd: string;
  readonly slug: string;
  readonly now: string;
  readonly resolvers: ChoiceResolvers;
  readonly pid?: number;
  readonly maxWallClockMinutes?: number;
  readonly explain?: boolean;
}

export interface RunResumeResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runResume(
  input: RunResumeInput,
  adapter: Adapter,
): Promise<RunResumeResult> {
  const lines: string[] = [];
  const errors: string[] = [];
  const notice = (line: string): void => {
    lines.push(line);
  };

  const paths = specPaths(input.cwd, input.slug);

  if (!existsSync(paths.statePath)) {
    errors.push(
      `samospec: no spec found for slug '${input.slug}'. ` +
        `Run \`samospec new ${input.slug}\` to start one.`,
    );
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${errors.join("\n")}\n`,
    };
  }

  const inspected = inspectSpec(input.cwd, input.slug);
  const state = inspected.state;
  if (state === null) {
    errors.push(
      `samospec: state.json for '${input.slug}' is missing or invalid.`,
    );
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${errors.join("\n")}\n`,
    };
  }

  // lead_terminal is absorbing (SPEC §7). Exit 4 with context.
  if (state.round_state === "lead_terminal") {
    errors.push(
      `samospec: spec '${input.slug}' is at lead_terminal. ` +
        `Edit .samo/spec/${input.slug}/ manually or rerun with --force.`,
    );
    return {
      exitCode: 4,
      stdout: "",
      stderr: `${errors.join("\n")}\n`,
    };
  }

  // Terminal happy state: already committed at v0.1, no more work.
  if (
    state.phase === "draft" &&
    state.round_state === "committed" &&
    state.version === V01_VERSION
  ) {
    notice(`samospec: spec '${input.slug}' at v0.1 — ready for review loop.`);
    notice(`next: samospec iterate ${input.slug}`);
    return {
      exitCode: 0,
      stdout: `${lines.join("\n")}\n`,
      stderr: "",
    };
  }

  // review_loop phase: spec is in active review or already converged.
  if (state.phase === "review_loop" && state.round_state === "committed") {
    notice(
      `samospec: spec '${input.slug}' at v${state.version} — ` +
        `review loop committed.`,
    );
    notice(`next: samospec publish ${input.slug}`);
    return {
      exitCode: 0,
      stdout: `${lines.join("\n")}\n`,
      stderr: "",
    };
  }

  // Acquire the repo lock for the resume window.
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
      errors.push(
        `samospec: another samospec run holds the repo lock (pid ${err.holderPid}). ` +
          `Wait for it to exit or remove ${err.lockPath} if stale.`,
      );
      return {
        exitCode: 2,
        stdout: "",
        stderr: `${errors.join("\n")}\n`,
      };
    }
    throw err;
  }

  try {
    // Case A: no persona yet — user must restart.
    if (state.persona === null) {
      errors.push(
        `samospec: spec '${input.slug}' has no persona yet. ` +
          `Re-run \`samospec new ${input.slug}\` to start over.`,
      );
      return {
        exitCode: 1,
        stdout: lines.join("\n"),
        stderr: `${errors.join("\n")}\n`,
      };
    }

    const personaStr = formatPersonaString(state.persona.skill);
    if (!PERSONA_FORM_RE.test(personaStr)) {
      errors.push(
        `samospec: state.persona.skill is malformed for '${input.slug}'.`,
      );
      return {
        exitCode: 1,
        stdout: lines.join("\n"),
        stderr: `${errors.join("\n")}\n`,
      };
    }

    let nextState: State = state;

    // Case B: persona present but interview missing. Re-enter interview.
    let interview: InterviewResult | null = null;
    if (!inspected.hasInterview) {
      notice(`resuming interview for '${input.slug}' (persona: ${personaStr})`);
      nextState = ensurePhaseAtLeast(nextState, "interview", input.now);
      writeState(paths.statePath, nextState);

      try {
        interview = await runInterview(
          {
            slug: input.slug,
            persona: personaStr,
            explain: input.explain ?? false,
            subscriptionAuth: await isSubscriptionAuth(adapter),
            onQuestion: input.resolvers.question,
            onNotice: notice,
            outputPath: paths.interviewPath,
            now: input.now,
          },
          adapter,
        );
      } catch (err) {
        if (err instanceof InterviewTerminalError) {
          const terminal: State = {
            ...nextState,
            round_state: "lead_terminal",
            updated_at: input.now,
          };
          writeState(paths.statePath, terminal);
          errors.push(`samospec: lead_terminal at interview — ${err.message}.`);
          return {
            exitCode: 4,
            stdout: lines.join("\n"),
            stderr: `${errors.join("\n")}\n`,
          };
        }
        errors.push(
          `samospec: interview interrupted — ${
            err instanceof Error ? err.message : String(err)
          }.`,
        );
        return {
          exitCode: 3,
          stdout: lines.join("\n"),
          stderr: `${errors.join("\n")}\n`,
        };
      }
      notice(
        `interview complete: written to ${path.basename(paths.interviewPath)}.`,
      );
    } else {
      interview = readInterview(paths.interviewPath);
      if (interview === null) {
        errors.push(
          `samospec: interview.json for '${input.slug}' present but unreadable.`,
        );
        return {
          exitCode: 1,
          stdout: lines.join("\n"),
          stderr: `${errors.join("\n")}\n`,
        };
      }
    }

    // Case C: interview in hand but SPEC.md missing -> run draft.
    if (!inspected.hasSpec) {
      nextState = ensurePhaseAtLeast(nextState, "draft", input.now);
      writeState(paths.statePath, nextState);

      // Re-run context discovery (SPEC §7: cheap + cached).
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
          `context refreshed: ${String(discovered.context.files.filter((f) => f.included).length)} file(s) included.`,
        );
      } catch (err) {
        notice(
          `context discovery skipped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        writeContextJson(ctxPath, {
          phase: "draft",
          files: [],
          risk_flags: [],
          budget: {
            phase: "draft",
            tokens_used: 0,
            tokens_budget: 0,
          },
        });
      }

      let draft;
      try {
        draft = await authorDraft(
          {
            slug: input.slug,
            idea: "(resumed)",
            persona: personaStr,
            interview,
            contextChunks: chunks,
            explain: input.explain ?? false,
          },
          adapter,
        );
      } catch (err) {
        if (err instanceof DraftTerminalError) {
          const terminal: State = {
            ...nextState,
            round_state: "lead_terminal",
            updated_at: input.now,
          };
          writeState(paths.statePath, terminal);
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

      writeFileSync(paths.specPath, ensureTrailingNewline(draft.spec), "utf8");
      writeFileSync(
        paths.tldrPath,
        renderTldr(draft.spec, { slug: input.slug, state: nextState }),
        "utf8",
      );
      if (!existsSync(paths.decisionsPath)) {
        writeFileSync(
          paths.decisionsPath,
          `# decisions\n\n- No review-loop decisions yet.\n`,
          "utf8",
        );
      }
      if (!existsSync(paths.changelogPath)) {
        writeFileSync(
          paths.changelogPath,
          `# changelog\n\n## v0.1 — ${input.now}\n\n- Initial draft authored by the lead (resumed).\n- Persona: ${personaStr}\n`,
          "utf8",
        );
      }
      // Interview was written either by runInterview above or by runNew
      // earlier; re-write defensively if it disappeared.
      if (!existsSync(paths.interviewPath) && interview !== null) {
        writeInterview(paths.interviewPath, {
          slug: interview.slug,
          persona: interview.persona,
          generated_at: interview.generated_at,
          questions: [...interview.questions],
          answers: [...interview.answers],
        });
      }

      nextState = {
        ...nextState,
        round_state: "committed",
        round_index: 0,
        version: V01_VERSION,
        updated_at: input.now,
      };
      writeState(paths.statePath, nextState);

      // Commit when we're on samospec/<slug>; otherwise skip commit but
      // keep artifacts on disk so a future run can commit.
      if (commitAllowed(input.cwd, input.slug)) {
        try {
          specCommit({
            repoPath: input.cwd,
            slug: input.slug,
            action: "draft",
            version: "0.1",
            paths: [
              relative(input.cwd, paths.specPath),
              relative(input.cwd, paths.tldrPath),
              relative(input.cwd, paths.statePath),
              relative(input.cwd, paths.interviewPath),
              relative(input.cwd, paths.contextPath),
              relative(input.cwd, paths.decisionsPath),
              relative(input.cwd, paths.changelogPath),
            ],
          });
          notice(`committed spec(${input.slug}): draft v0.1`);
        } catch (err) {
          if (err instanceof ProtectedBranchError) {
            // Mark the state so the user sees the file is drafted but
            // not committed, and give remediation.
            const lr: State = {
              ...nextState,
              round_state: "lead_revised",
              updated_at: input.now,
            };
            writeState(paths.statePath, lr);
            errors.push(
              `samospec: cannot commit v0.1 on protected branch '${err.branchName}'. ` +
                `Check out samospec/${input.slug} and resume.`,
            );
            return {
              exitCode: 2,
              stdout: lines.join("\n"),
              stderr: `${errors.join("\n")}\n`,
            };
          }
          throw err;
        }

        // Session-end calibration sample (SPEC §11).
        try {
          writeCalibrationSample({
            cwd: input.cwd,
            session_actual_tokens: approximateTokens(draft.usage),
            session_actual_cost_usd: extractCostUsd(draft.usage),
            session_rounds: 0,
          });
        } catch (err) {
          notice(
            `calibration sample skipped: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      } else {
        notice(
          `commit skipped (not on samospec/${input.slug}). Artifacts staged on disk.`,
        );
      }

      notice(`spec '${input.slug}' at v0.1 committed.`);
      notice(`next: samospec iterate ${input.slug}`);
      return {
        exitCode: 0,
        stdout: `${lines.join("\n")}\n`,
        stderr: "",
      };
    }

    // Case D: everything on disk; state hasn't advanced past interview.
    // Happens if a prior session wrote the files but crashed before
    // bumping state. Move state forward to committed+v0.1.
    if (state.phase === "interview" || state.phase === "draft") {
      const committed: State = {
        ...ensurePhaseAtLeast(state, "draft", input.now),
        round_state: "committed",
        round_index: 0,
        version: V01_VERSION,
        updated_at: input.now,
      };
      writeState(paths.statePath, committed);
    }

    notice(`spec '${input.slug}' at v0.1 committed.`);
    notice(`next: samospec iterate ${input.slug}`);
    return {
      exitCode: 0,
      stdout: `${lines.join("\n")}\n`,
      stderr: "",
    };
  } finally {
    releaseLock(handle);
  }
}

// ---------- helpers ----------

function ensurePhaseAtLeast(state: State, target: string, now: string): State {
  // Only move forward; no-op when already past.
  const order = [
    "detect",
    "branch_lock_preflight",
    "persona",
    "context",
    "interview",
    "draft",
    "review_loop",
    "publish",
  ];
  const currentIdx = order.indexOf(state.phase);
  const targetIdx = order.indexOf(target);
  if (targetIdx <= currentIdx) return state;
  let cur = state;
  for (let i = currentIdx + 1; i <= targetIdx; i += 1) {
    const next = order[i];
    if (next === undefined) break;
    cur = advancePhase(cur, next as State["phase"], { now });
  }
  return cur;
}

function relative(root: string, absolute: string): string {
  return path.relative(root, absolute);
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : `${s}\n`;
}

async function isSubscriptionAuth(adapter: Adapter): Promise<boolean> {
  try {
    const auth = await adapter.auth_status();
    return auth.subscription_auth === true;
  } catch {
    return false;
  }
}

function approximateTokens(
  usage: { input_tokens?: number; output_tokens?: number } | null,
): number {
  if (usage === null || usage === undefined) return 0;
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

function extractCostUsd(
  usage: { cost_usd?: number | undefined } | null,
): number | null {
  if (usage === null || usage === undefined) return null;
  if (typeof usage.cost_usd !== "number") return null;
  return usage.cost_usd;
}

/**
 * A commit is only safe if:
 *   - cwd is a git repo,
 *   - the current branch equals `samospec/<slug>`.
 *
 * This avoids committing onto a random checkout when a user happens to
 * resume from a different working tree.
 */
function commitAllowed(cwd: string, slug: string): boolean {
  try {
    const raw = readFileSync(path.join(cwd, ".git", "HEAD"), "utf8");
    // HEAD is "ref: refs/heads/<branch>\n" on a checked-out branch.
    const m = /^ref:\s+refs\/heads\/(.+)$/m.exec(raw.trim());
    if (m === null) return false;
    return m[1] === `samospec/${slug}`;
  } catch {
    return false;
  }
}
