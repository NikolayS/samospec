// Copyright 2026 Nikolay Samokhvalov.

// SPEC §5 + §7 — `samospec resume [<slug>]`.
// Phase-based resumption:
//   - no state.json => exit 1 with remediation.
//   - round_state === lead_terminal => exit 4 (immutable absorbing
//     state per SPEC §7).
//   - persona persisted but interview.json missing => re-enter the
//     interview phase (re-asks the lead for questions; the caller
//     is expected to re-answer via the resolver).
//   - interview.json present AND phase complete => emit the "next
//     phase: context / draft (not implemented yet)" message and
//     exit 0 (Issue #15 completes this).
//
// Scope guard: no context discovery, no v0.1 draft, no review loop.

import { existsSync } from "node:fs";
import path from "node:path";

import type { Adapter } from "../adapter/types.ts";
import {
  LockContendedError,
  acquireLock,
  releaseLock,
  type LockHandle,
} from "../state/lock.ts";
import { advancePhase } from "../state/phase.ts";
import { writeState } from "../state/store.ts";
import type { State } from "../state/types.ts";
import { PERSONA_FORM_RE, formatPersonaString } from "./persona.ts";
import {
  InterviewTerminalError,
  readInterview,
  runInterview,
} from "./interview.ts";
import { inspectSpec, specPaths, type ChoiceResolvers } from "./new.ts";

const DEFAULT_MAX_WALL_CLOCK_MIN = 240;

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
    // readState threw upstream of inspectSpec would have surfaced —
    // reaching here means the file existed but parsed to null (which
    // readState does not do; safeguard only).
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
        `Edit .samospec/spec/${input.slug}/ manually or rerun with --force.`,
    );
    return {
      exitCode: 4,
      stdout: "",
      stderr: `${errors.join("\n")}\n`,
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
    // Case A: persona present, interview missing -> re-enter interview.
    if (
      state.persona !== null &&
      state.persona.accepted &&
      !inspected.hasInterview
    ) {
      const personaStr = formatPersonaString(state.persona.skill);
      if (!PERSONA_FORM_RE.test(personaStr)) {
        errors.push(
          `samospec: state.persona.skill is malformed for '${input.slug}'.`,
        );
        return {
          exitCode: 1,
          stdout: "",
          stderr: `${errors.join("\n")}\n`,
        };
      }
      notice(`resuming interview for '${input.slug}' (persona: ${personaStr})`);

      let nextState: State = advancePhase(state, "interview", {
        now: input.now,
      });
      // advancePhase only moves forward; interview -> interview is a
      // no-op pass. If state.phase was already interview, this returns
      // the same state; otherwise we step once.
      if (nextState === state && state.phase !== "interview") {
        // Shouldn't happen; advancePhase throws on illegal moves.
        nextState = { ...state, phase: "interview", updated_at: input.now };
      }
      writeState(paths.statePath, nextState);

      try {
        await runInterview(
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
      notice(`TODO #15: next phase — context / draft — not implemented yet.`);
      return {
        exitCode: 0,
        stdout: `${lines.join("\n")}\n`,
        stderr: "",
      };
    }

    // Case B: interview done.
    if (inspected.hasInterview) {
      const iv = readInterview(paths.interviewPath);
      notice(
        `resume: persona + interview already persisted for '${input.slug}'.`,
      );
      if (iv !== null) {
        notice(
          `persona: ${iv.persona}; answers recorded: ${String(iv.answers.length)}.`,
        );
      }
      notice(
        `next phase: context / draft (not implemented yet). See issues #11 / #15.`,
      );
      return {
        exitCode: 0,
        stdout: `${lines.join("\n")}\n`,
        stderr: "",
      };
    }

    // Case C: persona not yet written. Tell the caller to re-run new.
    errors.push(
      `samospec: spec '${input.slug}' has no persona yet. ` +
        `Re-run \`samospec new ${input.slug}\` to start over.`,
    );
    return {
      exitCode: 1,
      stdout: lines.join("\n"),
      stderr: `${errors.join("\n")}\n`,
    };
  } finally {
    releaseLock(handle);
  }
}

async function isSubscriptionAuth(adapter: Adapter): Promise<boolean> {
  try {
    const auth = await adapter.auth_status();
    return auth.subscription_auth === true;
  } catch {
    return false;
  }
}
