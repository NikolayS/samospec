// Copyright 2026 Nikolay Samokhvalov.

import { homedir } from "node:os";
import * as readline from "node:readline/promises";

import { ClaudeAdapter } from "./adapter/claude.ts";
import { ClaudeResolver } from "./adapter/claude-resolver.ts";
import { ClaudeReviewerBAdapter } from "./adapter/claude-reviewer-b.ts";
import { CodexAdapter } from "./adapter/codex.ts";
import { createFakeAdapter } from "./adapter/fake-adapter.ts";
import type { Adapter } from "./adapter/types.ts";
import { runInit } from "./cli/init.ts";
import { runDoctor, type DoctorAdapterBinding } from "./cli/doctor.ts";
import { runIterate, type IterateResolvers } from "./cli/iterate.ts";
import { runNew, type ChoiceResolvers } from "./cli/new.ts";
import {
  PERSONA_FORM_RE,
  extractSkill,
  type PersonaChoice,
  type PersonaProposal,
} from "./cli/persona.ts";
import { runResume } from "./cli/resume.ts";
import { runStatus, type StatusAdapterBinding } from "./cli/status.ts";
import packageJson from "../package.json" with { type: "json" };

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const VERSION_FLAGS: ReadonlySet<string> = new Set([
  "version",
  "-v",
  "--version",
]);

const USAGE =
  "Usage: samospec <command>\n\n" +
  "Commands:\n" +
  "  init                        Create or refresh .samospec/ in the current repo.\n" +
  "  doctor                      Diagnose CLI availability, auth, git, lock, and config.\n" +
  "  new <slug> [--idea ...]     Start a new spec (persona + 5-question interview).\n" +
  "  resume [<slug>]             Resume an in-progress spec from state.json.\n" +
  "  iterate [<slug>] [--rounds] Run review rounds until a stopping condition fires.\n" +
  "  status [<slug>]             Print phase, round, cost, wall-clock, and next action.\n" +
  "  version                     Print the samospec version and exit.\n";

/**
 * Default adapter bindings for `samospec doctor`. Sprint 1 only ships
 * the fake adapter (real adapters land in Sprint 2+). The fake's
 * default program is tuned to `installed: true` + `authenticated: true`
 * + `subscription_auth: true`, which realistically surfaces every
 * branch of the doctor output when invoked interactively.
 */
function defaultAdapterBindings(): readonly DoctorAdapterBinding[] {
  return [
    { label: "claude", adapter: createFakeAdapter() },
    { label: "codex", adapter: createFakeAdapter() },
  ];
}

/**
 * Dispatch subcommands. Returns a Promise so async subcommands (doctor)
 * can resolve; synchronous subcommands (version, init) are wrapped.
 */
export async function runCli(argv: readonly string[]): Promise<CliResult> {
  const [command, ...rest] = argv;

  if (command !== undefined && VERSION_FLAGS.has(command)) {
    return {
      exitCode: 0,
      stdout: `${packageJson.version}\n`,
      stderr: "",
    };
  }

  if (command === undefined) {
    return { exitCode: 1, stdout: "", stderr: USAGE };
  }

  if (command === "init") {
    // Sprint 1 init takes no flags; ignore unused args.
    void rest;
    return runInit({ cwd: process.cwd() });
  }

  if (command === "doctor") {
    void rest;
    return runDoctor({
      cwd: process.cwd(),
      homeDir: homedir(),
      adapters: defaultAdapterBindings(),
    });
  }

  if (command === "new") {
    return runNewCommand(rest);
  }

  if (command === "resume") {
    return runResumeCommand(rest);
  }

  if (command === "iterate") {
    return runIterateCommand(rest);
  }

  if (command === "status") {
    return runStatusCommand(rest);
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: `samospec: unknown command '${command}'\n\n${USAGE}`,
  };
}

// ---------- command parsers ----------

interface NewArgs {
  readonly slug: string;
  readonly idea: string;
  readonly explain: boolean;
}

interface ResumeArgs {
  readonly slug: string;
  readonly explain: boolean;
}

function parseNewArgs(argv: readonly string[]): NewArgs | string {
  let slug: string | null = null;
  let idea: string | null = null;
  let explain = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === "--explain") {
      explain = true;
      continue;
    }
    if (token === "--idea") {
      idea = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (token.startsWith("--idea=")) {
      idea = token.slice("--idea=".length);
      continue;
    }
    if (token.startsWith("--")) {
      // Unknown flags ignored in this skeleton; #15 expands flag set.
      continue;
    }
    if (slug === null) {
      slug = token;
      continue;
    }
  }
  if (slug === null || slug.length === 0) {
    return "samospec new: missing <slug>";
  }
  return {
    slug,
    idea: idea ?? slug,
    explain,
  };
}

function parseResumeArgs(argv: readonly string[]): ResumeArgs | string {
  let slug: string | null = null;
  let explain = false;
  for (const token of argv) {
    if (token === "--explain") {
      explain = true;
      continue;
    }
    if (token.startsWith("--")) continue;
    slug ??= token;
  }
  if (slug === null || slug.length === 0) {
    return "samospec resume: missing <slug> (v1 does not auto-select)";
  }
  return { slug, explain };
}

// ---------- adapter + resolver wiring ----------

function leadAdapter(): Adapter {
  return new ClaudeAdapter();
}

/**
 * Interactive resolvers: prompt via stdin/stdout. When stdin is not a
 * TTY (piped / CI), defaults to accepting the proposal and choosing
 * the first option. Tests drive `runNew` / `runResume` directly with
 * deterministic resolvers, so this path is exercised only from a real
 * terminal invocation.
 */
function interactiveResolvers(): ChoiceResolvers {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return {
    persona: async (p: PersonaProposal): Promise<PersonaChoice> => {
      process.stdout.write(`\nPersona proposal: ${p.persona}\n`);
      process.stdout.write(`Rationale: ${p.rationale}\n`);
      const ans = (
        await rl.question(
          "[A]ccept / [E]dit skill / [R]eplace / [Enter=accept]: ",
        )
      )
        .trim()
        .toLowerCase();
      if (ans === "" || ans === "a" || ans === "accept") {
        return { kind: "accept" };
      }
      if (ans === "e" || ans === "edit") {
        const skill = (await rl.question("New skill: ")).trim();
        return { kind: "edit", skill };
      }
      if (ans === "r" || ans === "replace") {
        const persona = (
          await rl.question(
            'Full persona (must match Veteran "<skill>" expert): ',
          )
        ).trim();
        if (!PERSONA_FORM_RE.test(persona)) {
          return { kind: "accept" };
        }
        const skill = extractSkill(persona);
        if (skill === null) return { kind: "accept" };
        return { kind: "replace", persona };
      }
      return { kind: "accept" };
    },
    question: async (q) => {
      process.stdout.write(`\n${q.text}\n`);
      q.options.forEach((opt, idx) => {
        process.stdout.write(`  ${String(idx + 1)}. ${opt}\n`);
      });
      const pick = (
        await rl.question(`Pick 1-${String(q.options.length)} [1]: `)
      ).trim();
      const idx = pick === "" ? 0 : Number.parseInt(pick, 10) - 1;
      const chosen = q.options[idx] ?? q.options[0] ?? "decide for me";
      if (chosen === "custom") {
        const custom = (await rl.question("Custom answer: ")).trim();
        return { choice: "custom", custom };
      }
      return { choice: chosen };
    },
  };
}

async function runNewCommand(rest: readonly string[]) {
  const parsed = parseNewArgs(rest);
  if (typeof parsed === "string") {
    return { exitCode: 1, stdout: "", stderr: `${parsed}\n\n${USAGE}` };
  }
  const adapter = leadAdapter();
  return runNew(
    {
      cwd: process.cwd(),
      slug: parsed.slug,
      idea: parsed.idea,
      explain: parsed.explain,
      resolvers: interactiveResolvers(),
      now: new Date().toISOString(),
    },
    adapter,
  );
}

async function runResumeCommand(rest: readonly string[]) {
  const parsed = parseResumeArgs(rest);
  if (typeof parsed === "string") {
    return { exitCode: 1, stdout: "", stderr: `${parsed}\n\n${USAGE}` };
  }
  const adapter = leadAdapter();
  return runResume(
    {
      cwd: process.cwd(),
      slug: parsed.slug,
      now: new Date().toISOString(),
      resolvers: interactiveResolvers(),
      explain: parsed.explain,
    },
    adapter,
  );
}

// ---------- iterate / status ----------

interface IterateArgs {
  readonly slug: string;
  readonly rounds?: number;
}

function parseIterateArgs(argv: readonly string[]): IterateArgs | string {
  let slug: string | null = null;
  let rounds: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === undefined) continue;
    if (t === "--rounds") {
      const v = argv[i + 1];
      i += 1;
      if (v !== undefined) {
        const n = Number.parseInt(v, 10);
        if (Number.isFinite(n) && n > 0) rounds = n;
      }
      continue;
    }
    if (t.startsWith("--rounds=")) {
      const n = Number.parseInt(t.slice("--rounds=".length), 10);
      if (Number.isFinite(n) && n > 0) rounds = n;
      continue;
    }
    if (t.startsWith("--")) continue;
    slug ??= t;
  }
  if (slug === null || slug.length === 0) {
    return "samospec iterate: missing <slug>";
  }
  return rounds === undefined ? { slug } : { slug, rounds };
}

function parseStatusArgs(argv: readonly string[]): { slug: string } | string {
  let slug: string | null = null;
  for (const t of argv) {
    if (t.startsWith("--")) continue;
    slug ??= t;
  }
  if (slug === null || slug.length === 0) {
    return "samospec status: missing <slug>";
  }
  return { slug };
}

function buildReviewLoopAdapters(): {
  readonly lead: Adapter;
  readonly reviewerA: Adapter;
  readonly reviewerB: Adapter;
} {
  // Share one ClaudeResolver between lead + reviewer B to express the
  // SPEC §11 coupled-fallback linkage.
  const resolver = new ClaudeResolver();
  const lead = new ClaudeAdapter({ resolver });
  const reviewerA = new CodexAdapter();
  const reviewerB = new ClaudeReviewerBAdapter({ resolver });
  return { lead, reviewerA, reviewerB };
}

function interactiveIterateResolvers(): IterateResolvers {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return {
    onManualEdit: async (files) => {
      process.stdout.write(
        `\nUncommitted edits detected under .samospec/spec/ (${String(files.length)} file(s)):\n`,
      );
      for (const f of files) process.stdout.write(`  - ${f}\n`);
      const ans = (
        await rl.question(
          "[I]ncorporate / [O]verwrite / [A]bort [Enter=incorporate]: ",
        )
      )
        .trim()
        .toLowerCase();
      if (ans === "o" || ans === "overwrite") return "overwrite";
      if (ans === "a" || ans === "abort") return "abort";
      return "incorporate";
    },
    onDegraded: async (summary) => {
      process.stdout.write(`\n${summary}\n`);
      const ans = (await rl.question("[A]ccept / [B]bort [Enter=accept]: "))
        .trim()
        .toLowerCase();
      if (ans === "b" || ans === "abort") return "abort";
      return "accept";
    },
    onReviewerExhausted: async () => {
      process.stdout.write(
        `\nBoth reviewers failed after a whole-round retry.\n`,
      );
      const ans = (await rl.question("[C]ontinue / [A]bort [Enter=abort]: "))
        .trim()
        .toLowerCase();
      if (ans === "c" || ans === "continue") return "continue";
      return "abort";
    },
  };
}

async function runIterateCommand(rest: readonly string[]) {
  const parsed = parseIterateArgs(rest);
  if (typeof parsed === "string") {
    return { exitCode: 1, stdout: "", stderr: `${parsed}\n\n${USAGE}` };
  }
  const adapters = buildReviewLoopAdapters();
  const result = await runIterate({
    cwd: process.cwd(),
    slug: parsed.slug,
    now: new Date().toISOString(),
    resolvers: interactiveIterateResolvers(),
    adapters,
    ...(parsed.rounds !== undefined ? { maxRounds: parsed.rounds } : {}),
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function runStatusCommand(rest: readonly string[]) {
  const parsed = parseStatusArgs(rest);
  if (typeof parsed === "string") {
    return { exitCode: 1, stdout: "", stderr: `${parsed}\n\n${USAGE}` };
  }
  const adapters = buildReviewLoopAdapters();
  const bindings: readonly StatusAdapterBinding[] = [
    { role: "lead", adapter: adapters.lead },
    { role: "reviewer_a", adapter: adapters.reviewerA },
    { role: "reviewer_b", adapter: adapters.reviewerB },
  ];
  return runStatus({
    cwd: process.cwd(),
    slug: parsed.slug,
    now: new Date().toISOString(),
    adapters: bindings,
  });
}
