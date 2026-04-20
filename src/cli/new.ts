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
// Scope guardrails for Sprint 2 exit:
//   - NO push (Sprint 3 adds the consent-gated push).
//   - NO review loop (Sprint 3).
//   - NO reviewer adapters (Sprint 3).
//   - The safety invariant from Issue #3 holds: never commit on a
//     protected branch (createSpecBranch throws with exit 2; specCommit
//     additionally refuses).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Adapter } from "../adapter/types.ts";
import { discoverContext } from "../context/discover.ts";
import { contextJsonPath } from "../context/provenance.ts";
import { createSpecBranch } from "../git/branch.ts";
import { specCommit } from "../git/commit.ts";
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
  /** Always `true` in v1 per Issue #15 scope (consent-gated push is Sprint 3). */
  readonly noPush?: boolean;
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

  const samoDir = path.join(input.cwd, ".samo");
  const specsDir = path.join(samoDir, "spec");
  const slugDir = path.join(specsDir, input.slug);
  const lockPath = path.join(samoDir, ".lock");

  // Slug collision guard (SPEC §10): refuse any pre-existing slug
  // directory and suggest resume / --force.
  if (existsSync(slugDir)) {
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
    const preflightRes = runPreflight({
      cwd: input.cwd,
      adapter,
      subscriptionAuth: await resolveSubscriptionAuth(adapter),
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

    // Branch creation (SPEC §5 Phase 1 + §8).
    // Two modes:
    //   - test seam (input.enableBranchCreation===true + createBranch):
    //     invoke the stub and skip the real git-layer call.
    //   - default: try the real `createSpecBranch`. Outside a git repo
    //     this throws; we catch + surface "branch creation skipped"
    //     so legacy tests that don't initialize a git repo still run.
    const branchResult = createBranch(input);
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
    } else if (branchResult.kind === "skipped") {
      notice(`branch creation skipped (${branchResult.reason}).`);
    } else if (branchResult.kind === "stub") {
      notice(`branch stub invoked: samospec/${input.slug}.`);
    }

    // Materialize the slug directory.
    mkdirSync(slugDir, { recursive: true });

    // Initial state.json. Starts at phase 'detect' and advances as we
    // make progress so a crash leaves a truthful state record.
    let state = newState({ slug: input.slug, now: input.now });
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
      draft = await authorDraft(
        {
          slug: input.slug,
          idea: input.idea,
          persona: persona.persona,
          interview,
          contextChunks: chunks,
          explain: input.explain,
        },
        adapter,
      );
    } catch (err) {
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

    // TLDR.md: heuristic render.
    const tldr = renderTldr(draft.spec, { slug: input.slug });
    writeFileSync(tldrPath, tldr, "utf8");

    // decisions.md: empty seed with a "no decisions yet" preamble.
    writeFileSync(
      decisionsPath,
      `# decisions\n\n- No review-loop decisions yet. Populated during Sprint 3.\n`,
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
    state = {
      ...state,
      round_state: "committed",
      round_index: 0,
      version: V01_VERSION,
      updated_at: input.now,
    };
    writeState(statePath, state);

    // ---------- first commit on samospec/<slug> ----------

    if (branchResult.kind === "created") {
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
      `next: \`samospec resume ${input.slug}\` (review loop lands in Sprint 3).`,
    );

    if (input.noPush !== false) {
      // SPEC §8 + Issue #15 scope: no push in this sprint.
      notice(
        `(--no-push default active; push consent gate ships in Sprint 3.)`,
      );
    }

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
      subscription_auth: false,
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
  | { kind: "skipped"; reason: string }
  | { kind: "stub"; branch: string }
  | { kind: "protected"; branch: string };

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
