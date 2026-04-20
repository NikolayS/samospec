// Copyright 2026 Nikolay Samokhvalov.

// SPEC §5 Phases 1-4 skeleton for `samospec new <slug>`.
// Wires:
//   - lockfile acquisition (src/state/lock.ts)
//   - branch creation stub (src/git/branch.ts — guarded by flag, SPEC §15
//     Sprint 3 task #15 will wire real invocation)
//   - persona proposal (src/cli/persona.ts)
//   - interview (src/cli/interview.ts)
//   - TODO markers for context / preflight / draft (issues #11 / #14 /
//     #15 to follow)
//
// Scope guard (SPEC §13 test 3 persona + test 2 interview):
//   - No context discovery; no preflight cost estimate; no v0.1 draft.
//   - Branch creation is behind enableBranchCreation flag so #15 can
//     wire the real call without touching this file's tests.

import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { Adapter } from "../adapter/types.ts";
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
  PersonaTerminalError,
  extractSkill,
  proposePersona,
  type PersonaChoice,
  type PersonaProposal,
} from "./persona.ts";
import {
  InterviewTerminalError,
  readInterview,
  runInterview,
  type InterviewResult,
  type OnQuestionCallback,
} from "./interview.ts";

const DEFAULT_MAX_WALL_CLOCK_MIN = 240;

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
  /** Opt-in git branch creation (SPEC #15 Sprint 3). Default: false. */
  readonly enableBranchCreation?: boolean;
  /**
   * Injected branch-creator seam. Default resolves to a no-op when
   * enableBranchCreation is false. When true, invoked exactly once
   * after lock acquisition.
   */
  readonly createBranch?: (slug: string) => string;
  /** Override for max wall-clock minutes (lock staleness cutoff). */
  readonly maxWallClockMinutes?: number;
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

  const samoDir = path.join(input.cwd, ".samospec");
  const specsDir = path.join(samoDir, "spec");
  const slugDir = path.join(specsDir, input.slug);
  const lockPath = path.join(samoDir, ".lock");

  // Slug collision guard (SPEC §10): refuse any pre-existing slug
  // directory and suggest resume / --force.
  if (existsSync(slugDir)) {
    errors.push(
      `samospec: .samospec/spec/${input.slug}/ already exists. ` +
        `Try \`samospec resume ${input.slug}\` or ` +
        `\`samospec new ${input.slug} --force\` to archive the old run.`,
    );
    return {
      exitCode: 1,
      stdout: lines.join("\n"),
      stderr: `${errors.join("\n")}\n`,
    };
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
    // Branch creation seam (SPEC §5 Phase 1 + SPEC §15 task #15).
    if (input.enableBranchCreation === true) {
      const createBranch = input.createBranch;
      if (createBranch !== undefined) {
        createBranch(input.slug);
      }
      notice(`TODO #15: branch 'samospec/${input.slug}' created (stub).`);
    } else {
      notice(
        `TODO #15: branch creation deferred (set enableBranchCreation=true to opt in).`,
      );
    }

    // Materialize the slug directory.
    mkdirSync(slugDir, { recursive: true });

    // Initial state.json. Starts at phase 'detect' and advances as we
    // make progress so a crash leaves a truthful state record.
    let state = newState({ slug: input.slug, now: input.now });
    const statePath = path.join(slugDir, "state.json");
    writeState(statePath, state);

    // Phase-advance seam: each phase we enter bumps the phase pointer
    // and re-persists so resume starts from the right place.
    state = advancePhase(state, "branch_lock_preflight", { now: input.now });
    writeState(statePath, state);

    // TODO markers (#14 preflight cost, #11 context discovery).
    notice(
      `TODO #14: preflight cost estimate deferred (no paid lead calls before preflight land).`,
    );

    // Phase 2 — persona.
    state = advancePhase(state, "persona", { now: input.now });
    writeState(statePath, state);

    const subAuth = await resolveSubscriptionAuth(adapter);
    let persona: PersonaProposal;
    try {
      persona = await proposePersonaInteractive(
        {
          idea: input.idea,
          explain: input.explain,
          subscriptionAuth: subAuth,
          onNotice: notice,
          resolver: input.resolvers.persona,
        },
        adapter,
      );
    } catch (err) {
      if (err instanceof PersonaTerminalError) {
        state = { ...state, round_state: "lead_terminal" };
        state.updated_at = input.now;
        writeState(statePath, state);
        errors.push(
          `samospec: lead_terminal at persona — ${err.detail}. ` +
            `Edit .samospec/spec/${input.slug}/ manually or restart with --force.`,
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

    // Phase 3 — context discovery (TODO #11).
    state = advancePhase(state, "context", { now: input.now });
    writeState(statePath, state);
    notice(
      `TODO #11: context discovery deferred (interview uses idea-only context for now).`,
    );

    // Phase 4 — interview.
    state = advancePhase(state, "interview", { now: input.now });
    writeState(statePath, state);

    const interviewPath = path.join(slugDir, "interview.json");
    let interview: InterviewResult;
    try {
      interview = await runInterview(
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
      );
    } catch (err) {
      if (err instanceof InterviewTerminalError) {
        state = { ...state, round_state: "lead_terminal" };
        state.updated_at = input.now;
        writeState(statePath, state);
        errors.push(
          `samospec: lead_terminal at interview — ${err.message}. ` +
            `Edit .samospec/spec/${input.slug}/ manually or restart with --force.`,
        );
        return {
          exitCode: 4,
          stdout: lines.join("\n"),
          stderr: `${errors.join("\n")}\n`,
        };
      }
      // Any other error (e.g. question-callback reject, simulating a
      // user Ctrl-C) is classified as interrupted (SPEC §10 exit 3).
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

    // TODO markers for the next unimplemented phases.
    notice(
      `TODO #15: v0.1 draft deferred. Next phase: context / draft — not implemented yet.`,
    );

    // Final state: phase remains `interview` until #15 advances us.
    state.updated_at = input.now;
    writeState(statePath, state);

    return {
      exitCode: 0,
      stdout: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
      stderr: "",
    };
  } finally {
    releaseLock(handle);
  }
}

// ---------- helpers ----------

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

/**
 * Two-step persona flow: first call proposePersona in "accept" mode
 * just to surface the proposal; then ask the resolver for the real
 * choice; if the resolver returns anything other than accept, invoke
 * proposePersona again with the real choice (edit/replace short-
 * circuits the ask path because the persona string is already valid).
 *
 * We rely on proposePersona's pure applyChoice on the first result:
 * we pass through the PersonaProposal returned in step 1 and re-
 * invoke only for edit/replace so the caller sees a single "call the
 * lead once" happy path for accept.
 */
async function proposePersonaInteractive(
  input: PersonaInteractiveInput,
  adapter: Adapter,
): Promise<PersonaProposal> {
  // The first invocation is a dry-run to surface the proposal to the
  // user via the resolver. We still want subscription-auth copy + the
  // lead call to happen exactly once. proposePersona only makes the
  // call on the first attempt; edit/replace do NOT re-ask. To support
  // this, we call once with kind=accept, then apply the resolver's
  // final choice locally via a second invocation (which re-uses the
  // validated persona form, so won't re-hit the lead).
  //
  // Implementation detail: proposePersona always hits the lead once
  // regardless of choice, so we drive two invocations naturally and
  // cache the first proposal.

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

  // Surface the draft to the user; SPEC §11 message was printed if
  // applicable inside the first call.
  input.onNotice(`proposed persona: ${draft.persona}`);
  input.onNotice(`rationale: ${draft.rationale}`);

  const choice = await input.resolver(draft);

  if (choice.kind === "accept") {
    return draft;
  }

  // For edit/replace, reuse applyChoice via a second proposePersona
  // call path. We want no second lead call — but proposePersona always
  // hits the lead, so we synthesize the result manually.
  if (choice.kind === "edit") {
    return {
      persona: `Veteran "${choice.skill}" expert`,
      skill: choice.skill,
      rationale: draft.rationale,
      accepted: true,
    };
  }
  // kind === "replace"
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

// ---------- diagnostic readers (used by resume) ----------

export interface SpecPaths {
  readonly slugDir: string;
  readonly statePath: string;
  readonly interviewPath: string;
  readonly lockPath: string;
}

export function specPaths(cwd: string, slug: string): SpecPaths {
  const slugDir = path.join(cwd, ".samospec", "spec", slug);
  return {
    slugDir,
    statePath: path.join(slugDir, "state.json"),
    interviewPath: path.join(slugDir, "interview.json"),
    lockPath: path.join(cwd, ".samospec", ".lock"),
  };
}

export interface SpecInspection {
  readonly state: State | null;
  readonly hasInterview: boolean;
}

export function inspectSpec(cwd: string, slug: string): SpecInspection {
  const paths = specPaths(cwd, slug);
  const state = readState(paths.statePath);
  const hasInterview = readInterview(paths.interviewPath) !== null;
  return { state, hasInterview };
}
