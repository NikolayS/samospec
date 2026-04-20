// Copyright 2026 Nikolay Samokhvalov.

import { homedir } from "node:os";
import * as readline from "node:readline/promises";

import { ClaudeAdapter } from "./adapter/claude.ts";
import { createFakeAdapter } from "./adapter/fake-adapter.ts";
import type { Adapter } from "./adapter/types.ts";
import { runInit } from "./cli/init.ts";
import { runDoctor, type DoctorAdapterBinding } from "./cli/doctor.ts";
import { runNew, type ChoiceResolvers } from "./cli/new.ts";
import {
  PERSONA_FORM_RE,
  extractSkill,
  type PersonaChoice,
  type PersonaProposal,
} from "./cli/persona.ts";
import { runResume } from "./cli/resume.ts";
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
