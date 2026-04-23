// Copyright 2026 Nikolay Samokhvalov.

import { homedir } from "node:os";
import * as readline from "node:readline/promises";

import { ClaudeAdapter } from "./adapter/claude.ts";
import { ClaudeResolver } from "./adapter/claude-resolver.ts";
import { ClaudeReviewerBAdapter } from "./adapter/claude-reviewer-b.ts";
import { CodexAdapter } from "./adapter/codex.ts";
import { BASELINE_SECTION_NAMES, type Adapter } from "./adapter/types.ts";
import { runInit } from "./cli/init.ts";
import { runDoctor, type DoctorAdapterBinding } from "./cli/doctor.ts";
import {
  runIterate,
  type IterateResolvers,
  type ManualEditResolver,
  type PushOptions,
  type SeatDiagnostics,
} from "./cli/iterate.ts";
import { describePrCapability } from "./git/push-consent.ts";
import { runNew, type ChoiceResolvers } from "./cli/new.ts";
import {
  buildNonInteractiveResolvers,
  loadAnswersFile,
} from "./cli/non-interactive.ts";
import { runPublish } from "./cli/publish.ts";
import {
  PERSONA_FORM_RE,
  extractSkill,
  type PersonaChoice,
  type PersonaProposal,
} from "./cli/persona.ts";
import { runResume } from "./cli/resume.ts";
import { runStatus, type StatusAdapterBinding } from "./cli/status.ts";
import type { ManualEditChoice } from "./git/manual-edit.ts";
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

/**
 * Wrap a comma-separated list of items across lines of at most `width`
 * visible chars, prefixing every line (including the first) with `indent`.
 * Used so the baseline-sections enumeration in USAGE stays readable on
 * narrow terminals instead of blowing past 80 chars on one line.
 */
function wrapList(
  items: readonly string[],
  indent: string,
  width: number,
): string {
  const lines: string[] = [];
  let current = indent;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item === undefined) continue;
    const isLast = i === items.length - 1;
    const piece = isLast ? item : `${item},`;
    const candidate =
      current === indent ? current + piece : `${current} ${piece}`;
    if (candidate.length > width && current !== indent) {
      lines.push(current);
      current = indent + piece;
    } else {
      current = candidate;
    }
  }
  lines.push(current);
  return lines.join("\n");
}

const USAGE =
  "Usage: samospec <command> [options]\n" +
  "\n" +
  "Commands:\n" +
  "  init              Create or refresh .samo/ in the current repo.\n" +
  "  doctor            Diagnose CLI availability, auth, git, lock, and config.\n" +
  "  new <slug>        Start a new spec (persona + 5-question interview).\n" +
  "  resume [<slug>]   Resume an in-progress spec from state.json.\n" +
  "  iterate [<slug>]  Run review rounds until a stopping condition fires.\n" +
  "  status [<slug>]   Print phase, round, cost, wall-clock, and next action.\n" +
  "  publish [<slug>]  Promote to blueprints/<slug>/SPEC.md; commit, push, open PR.\n" +
  "  version           Print the samospec version and exit.\n" +
  "\n" +
  "Options for `new`:\n" +
  "  --idea <text>\n" +
  "      Initial idea text (default: the <slug>).\n" +
  "  --force\n" +
  "      Archive any existing run, then start fresh.\n" +
  "  --skip <sections>\n" +
  "      Omit baseline sections from the mandatory template\n" +
  "      (comma-separated, case-insensitive). Valid sections:\n" +
  wrapList(BASELINE_SECTION_NAMES, "      ", 78) +
  ".\n" +
  "  --max-session-wall-clock-ms <ms>\n" +
  "      Cap total session wall-clock (positive integer ms). Defaults to\n" +
  "      budget.max_session_wall_clock_minutes in config.json, or 600000\n" +
  "      (10 min). On cap: exit 4 with reason `session-wall-clock`.\n" +
  "  --verbose\n" +
  "      Emit per-phase and per-file diagnostics on stderr (stdout stays concise).\n" +
  "  --yes, --accept-persona\n" +
  "      Skip the persona-proposal readline prompt.\n" +
  "  --answers-file <path>\n" +
  "      Load 5-question interview answers from JSON\n" +
  '      (`{ "answers": [s, s, s, s, s] }`). One of --yes, --accept-persona,\n' +
  "      or --answers-file is required when stdin is not a TTY (#114).\n" +
  "\n" +
  "Options for `iterate`:\n" +
  "  --rounds <N>\n" +
  "      Cap the number of review rounds this session.\n" +
  "  --no-push\n" +
  "      Don't push round commits to the remote.\n" +
  "  --remote <name>\n" +
  "      Git remote name (default: origin).\n" +
  "  --quiet\n" +
  "      Suppress per-phase progress + heartbeat (default: verbose on stderr).\n" +
  "  --max-session-wall-clock-ms <ms>\n" +
  "      Cap the review-loop session wall-clock (positive integer ms). On cap:\n" +
  "      exit 4 with reason `session-wall-clock`.\n" +
  "  --on-dirty <incorporate|overwrite|abort>\n" +
  "      Answer the uncommitted-edits prompt without reading stdin. Required\n" +
  "      when stdin is not a TTY and `.samo/spec/<slug>/` has dirty edits (#114).\n" +
  "\n" +
  "Options for `publish`:\n" +
  "  --no-lint\n" +
  "      Skip the publish-time lint pass.\n" +
  "  --remote <name>\n" +
  "      Git remote name (default: origin).\n";

/**
 * Default adapter bindings for `samospec doctor`. Uses the real
 * ClaudeAdapter and CodexAdapter (shipped in Sprints 2–3) so that
 * doctor probes the actual installed CLIs on the user's PATH. The
 * fake adapter is for tests only and must not appear here.
 */
function defaultAdapterBindings(): readonly DoctorAdapterBinding[] {
  return [
    { label: "claude", adapter: new ClaudeAdapter() },
    { label: "codex", adapter: new CodexAdapter() },
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
    const yes = rest.includes("--yes") || rest.includes("--no-interactive");
    return runInit({ cwd: process.cwd(), ...(yes ? { yes: true } : {}) });
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

  if (command === "publish") {
    return runPublishCommand(rest);
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
  readonly skipSections?: readonly string[];
  readonly force: boolean;
  readonly maxSessionWallClockMs?: number;
  readonly verbose: boolean;
  /**
   * #114: non-TTY automation surface.
   *   - `acceptPersona`: accept the lead's persona proposal without prompting.
   *   - `answersFile`: absolute or relative path to a JSON file with
   *     `{ "answers": [string x 5] }`. When present, skips the 5Q readline.
   *   - `yes`: broad "accept everything" — implies `acceptPersona=true` and
   *     lets interview fall back to `"decide for me"` for every question.
   */
  readonly acceptPersona: boolean;
  readonly yes: boolean;
  readonly answersFile?: string;
}

interface ResumeArgs {
  readonly slug: string;
  readonly explain: boolean;
}

/**
 * Parse the `--skip` value (comma-separated) and validate each entry
 * against BASELINE_SECTION_NAMES (case-insensitive). Returns the
 * canonical list on success, or an error string on failure.
 */
function parseSkipList(raw: string): readonly string[] | string {
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) {
    return (
      "samospec new: --skip requires one or more section names " +
      `(comma-separated). Valid: ${BASELINE_SECTION_NAMES.join(", ")}.`
    );
  }
  const canonicalByLower = new Map<string, string>();
  for (const name of BASELINE_SECTION_NAMES) {
    canonicalByLower.set(name.toLowerCase(), name);
    // Also accept hyphen-for-space variant (`user-stories` ↔ `user stories`).
    canonicalByLower.set(name.toLowerCase().replace(/ /g, "-"), name);
  }
  const canonical: string[] = [];
  const unknown: string[] = [];
  for (const entry of entries) {
    const match = canonicalByLower.get(entry.toLowerCase());
    if (match === undefined) {
      unknown.push(entry);
    } else {
      canonical.push(match);
    }
  }
  if (unknown.length > 0) {
    return (
      `samospec new: unknown baseline section(s) in --skip: ` +
      `${unknown.join(", ")}. Valid section names: ` +
      `${BASELINE_SECTION_NAMES.join(", ")}.`
    );
  }
  return canonical;
}

function parseNewArgs(argv: readonly string[]): NewArgs | string {
  let slug: string | null = null;
  let idea: string | null = null;
  let explain = false;
  let force = false;
  let verbose = false;
  let skipSections: readonly string[] | undefined;
  let maxSessionWallClockMs: number | undefined;
  let acceptPersona = false;
  let yes = false;
  let answersFile: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === "--explain") {
      explain = true;
      continue;
    }
    if (token === "--force") {
      force = true;
      continue;
    }
    if (token === "--verbose") {
      // Issue #77: gate targeted per-phase + per-file diagnostic lines
      // on stderr. stdout stays concise so pipelines that parse the
      // happy-path output don't break.
      verbose = true;
      continue;
    }
    if (token === "--yes" || token === "--no-interactive") {
      yes = true;
      continue;
    }
    if (token === "--accept-persona") {
      acceptPersona = true;
      continue;
    }
    if (token === "--answers-file") {
      const raw = argv[i + 1] ?? "";
      i += 1;
      if (raw.length === 0 || raw.startsWith("--")) {
        return "samospec new: --answers-file requires a path";
      }
      answersFile = raw;
      continue;
    }
    if (token.startsWith("--answers-file=")) {
      const raw = token.slice("--answers-file=".length);
      if (raw.length === 0) {
        return "samospec new: --answers-file requires a path";
      }
      answersFile = raw;
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
    if (token === "--skip") {
      const raw = argv[i + 1] ?? "";
      i += 1;
      const parsed = parseSkipList(raw);
      if (typeof parsed === "string") return parsed;
      skipSections = parsed;
      continue;
    }
    if (token.startsWith("--skip=")) {
      const raw = token.slice("--skip=".length);
      const parsed = parseSkipList(raw);
      if (typeof parsed === "string") return parsed;
      skipSections = parsed;
      continue;
    }
    if (token === "--max-session-wall-clock-ms") {
      const raw = argv[i + 1] ?? "";
      i += 1;
      const parsed = parseMaxSessionWallClockMs(raw);
      if (typeof parsed === "string") return parsed;
      maxSessionWallClockMs = parsed;
      continue;
    }
    if (token.startsWith("--max-session-wall-clock-ms=")) {
      const raw = token.slice("--max-session-wall-clock-ms=".length);
      const parsed = parseMaxSessionWallClockMs(raw);
      if (typeof parsed === "string") return parsed;
      maxSessionWallClockMs = parsed;
      continue;
    }
    if (token.startsWith("--")) {
      // Unknown flags ignored (permissive for future flags).
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
    force,
    verbose,
    acceptPersona,
    yes,
    ...(skipSections !== undefined ? { skipSections } : {}),
    ...(maxSessionWallClockMs !== undefined ? { maxSessionWallClockMs } : {}),
    ...(answersFile !== undefined ? { answersFile } : {}),
  };
}

/**
 * Parse and validate --max-session-wall-clock-ms. Accepts a positive
 * integer string (digits only; no decimals, no scientific notation).
 * Returns the integer ms on success, or an error string to be echoed
 * above the USAGE line.
 */
function parseMaxSessionWallClockMs(raw: string): number | string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "samospec new: --max-session-wall-clock-ms requires a value";
  }
  if (!/^\d+$/.test(trimmed)) {
    return (
      "samospec new: --max-session-wall-clock-ms must be a positive integer " +
      `(got '${raw}')`
    );
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return (
      "samospec new: --max-session-wall-clock-ms must be a positive integer " +
      `(got '${raw}')`
    );
  }
  return n;
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
  // Non-TTY / automation guard (#114). Decide the resolver strategy
  // BEFORE any readline interface is created — the pre-#114 code
  // constructed a readline at module-import time, which crashed with
  // ERR_USE_AFTER_CLOSE the moment a non-TTY stdin got closed.
  const resolversOrErr = buildNewResolvers(parsed);
  if (typeof resolversOrErr === "string") {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${resolversOrErr}\n\n${USAGE}`,
    };
  }
  const adapter = leadAdapter();
  return runNew(
    {
      cwd: process.cwd(),
      slug: parsed.slug,
      idea: parsed.idea,
      explain: parsed.explain,
      force: parsed.force,
      verbose: parsed.verbose,
      resolvers: resolversOrErr,
      now: new Date().toISOString(),
      ...(parsed.skipSections !== undefined
        ? { skipSections: [...parsed.skipSections] }
        : {}),
      ...(parsed.maxSessionWallClockMs !== undefined
        ? { maxSessionWallClockMs: parsed.maxSessionWallClockMs }
        : {}),
    },
    adapter,
  );
}

/**
 * #114 — pick the `ChoiceResolvers` strategy for `samospec new` based
 * on the parsed flags and whether stdin is a TTY.
 *
 *   - stdin is TTY: default to the interactive readline resolver.
 *   - stdin is NOT a TTY and any of `--yes`, `--accept-persona`,
 *     `--answers-file` is present: build a non-interactive resolver.
 *   - stdin is NOT a TTY and NO automation flag: return an error
 *     string so the CLI exits 1 fast with actionable guidance, rather
 *     than crashing on the first `rl.question()` call.
 *
 * When `--answers-file` is present but malformed, surface the loader's
 * error verbatim so the user can jump to the offending line.
 */
function buildNewResolvers(parsed: NewArgs): ChoiceResolvers | string {
  const hasAutomationFlag =
    parsed.yes || parsed.acceptPersona || parsed.answersFile !== undefined;
  const stdinIsTty = process.stdin.isTTY === true;

  if (!stdinIsTty && !hasAutomationFlag) {
    return (
      "samospec new: stdin is not a TTY (piped, CI, background). " +
      "Pass one of --yes, --accept-persona, or --answers-file <path> " +
      "to run non-interactively."
    );
  }

  let answers: readonly string[] | undefined;
  if (parsed.answersFile !== undefined) {
    const loaded = loadAnswersFile(parsed.answersFile);
    if (!loaded.ok) return loaded.error;
    answers = loaded.answers;
  }

  if (hasAutomationFlag) {
    return buildNonInteractiveResolvers({
      acceptPersona: parsed.yes || parsed.acceptPersona,
      answers,
    });
  }
  return interactiveResolvers();
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
  readonly noPush: boolean;
  readonly remote: string;
  readonly quiet: boolean;
  readonly maxSessionWallClockMs?: number;
  /**
   * #114: when set, `iterate` answers the uncommitted-edits prompt
   * without reading stdin. Required in non-TTY contexts where
   * `.samo/spec/<slug>/` has dirty edits.
   */
  readonly onDirty?: ManualEditChoice;
}

const ON_DIRTY_CHOICES: readonly ManualEditChoice[] = [
  "incorporate",
  "overwrite",
  "abort",
];

type ParseOnDirtyResult =
  | { readonly ok: true; readonly value: ManualEditChoice }
  | { readonly ok: false; readonly error: string };

function parseOnDirty(raw: string): ParseOnDirtyResult {
  const norm = raw.trim().toLowerCase();
  if (ON_DIRTY_CHOICES.includes(norm as ManualEditChoice)) {
    return { ok: true, value: norm as ManualEditChoice };
  }
  return {
    ok: false,
    error:
      `samospec iterate: --on-dirty must be one of ${ON_DIRTY_CHOICES.join("|")} ` +
      `(got '${raw}')`,
  };
}

/**
 * Centralised allow-list of long flags recognised by `samospec iterate`
 * (Issue #91). Parser compares every `--…` token against this set and
 * rejects unknown flags instead of silently dropping them — this catches
 * typos like `--rouns 5`. Keep bare names (no `=value` suffix); the
 * parser strips `=…` before lookup.
 */
const ITERATE_ALLOWED_FLAGS: ReadonlySet<string> = new Set([
  "--rounds",
  "--no-push",
  "--remote",
  "--quiet",
  // #128: no-op alias so `iterate --verbose` matches muscle-memory from `new`.
  "--verbose",
  "--max-session-wall-clock-ms",
  // #114: non-TTY automation.
  "--on-dirty",
]);

function parseIterateArgs(argv: readonly string[]): IterateArgs | string {
  let slug: string | null = null;
  let rounds: number | undefined;
  let noPush = false;
  let remote = "origin";
  let quiet = false;
  let maxSessionWallClockMs: number | undefined;
  let onDirty: ManualEditChoice | undefined;
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
    if (t === "--no-push") {
      noPush = true;
      continue;
    }
    if (t === "--quiet") {
      // Issue #101: suppress per-phase + heartbeat; final summary still
      // prints. No-op when combined with `--rounds 0` or similar.
      quiet = true;
      continue;
    }
    if (t === "--verbose") {
      // Issue #128: iterate is verbose by default; accept --verbose as a
      // no-op alias so muscle-memory from `samospec new --verbose` works.
      continue;
    }
    if (t === "--on-dirty") {
      const raw = argv[i + 1] ?? "";
      i += 1;
      const parsed = parseOnDirty(raw);
      if (!parsed.ok) return parsed.error;
      onDirty = parsed.value;
      continue;
    }
    if (t.startsWith("--on-dirty=")) {
      const raw = t.slice("--on-dirty=".length);
      const parsed = parseOnDirty(raw);
      if (!parsed.ok) return parsed.error;
      onDirty = parsed.value;
      continue;
    }
    if (t === "--remote") {
      const v = argv[i + 1];
      i += 1;
      if (v !== undefined && v.length > 0) remote = v;
      continue;
    }
    if (t.startsWith("--remote=")) {
      remote = t.slice("--remote=".length);
      continue;
    }
    if (t === "--max-session-wall-clock-ms") {
      const raw = argv[i + 1] ?? "";
      i += 1;
      const parsed = parseMaxSessionWallClockMs(raw);
      if (typeof parsed === "string") {
        // Rewrite the `new`-prefixed error so the CLI path matches
        // `iterate` (same helper; different subcommand).
        return parsed.replace("samospec new", "samospec iterate");
      }
      maxSessionWallClockMs = parsed;
      continue;
    }
    if (t.startsWith("--max-session-wall-clock-ms=")) {
      const raw = t.slice("--max-session-wall-clock-ms=".length);
      const parsed = parseMaxSessionWallClockMs(raw);
      if (typeof parsed === "string") {
        return parsed.replace("samospec new", "samospec iterate");
      }
      maxSessionWallClockMs = parsed;
      continue;
    }
    if (t.startsWith("--")) {
      // Issue #91: reject unknown flags instead of silently dropping
      // them. Strip any `=value` suffix before the allow-list lookup
      // so `--rouns=5` is caught the same as `--rouns 5`.
      const bareFlag = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
      if (!ITERATE_ALLOWED_FLAGS.has(bareFlag)) {
        return `samospec iterate: unknown flag '${bareFlag}'`;
      }
      continue;
    }
    slug ??= t;
  }
  if (slug === null || slug.length === 0) {
    return "samospec iterate: missing <slug>";
  }
  return {
    slug,
    noPush,
    remote,
    quiet,
    ...(rounds !== undefined ? { rounds } : {}),
    ...(maxSessionWallClockMs !== undefined ? { maxSessionWallClockMs } : {}),
    ...(onDirty !== undefined ? { onDirty } : {}),
  };
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

/**
 * #114 — build the manual-edit resolver.
 *
 *   - `onDirty` flag set: return a resolver that answers without any
 *     readline call, so `iterate` never touches stdin.
 *   - stdin is NOT a TTY and `onDirty` is NOT set: return a resolver
 *     that surfaces a clear error string via `throw` when the dirty
 *     path fires. `iterate` catches this and exits 1 cleanly rather
 *     than deadlocking the readline prompt.
 *   - default: the legacy interactive prompt.
 */
function buildManualEditResolver(
  rl: readline.Interface,
  onDirty: ManualEditChoice | undefined,
): ManualEditResolver {
  if (onDirty !== undefined) {
    return (_files) => Promise.resolve(onDirty);
  }
  const stdinIsTty = process.stdin.isTTY === true;
  if (!stdinIsTty) {
    return (files) => {
      const detail =
        files.length === 0 ? "(0 files)" : `(${String(files.length)} file(s))`;
      return Promise.reject(
        new Error(
          `samospec iterate: uncommitted edits under .samo/spec/ ${detail} ` +
            "but stdin is not a TTY. Pass --on-dirty " +
            "<incorporate|overwrite|abort> to run non-interactively.",
        ),
      );
    };
  }
  return async (files) => {
    process.stdout.write(
      `\nUncommitted edits detected under .samo/spec/ (${String(files.length)} file(s)):\n`,
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
  };
}

function interactiveIterateResolvers(
  onDirty: ManualEditChoice | undefined,
): IterateResolvers {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return {
    onManualEdit: buildManualEditResolver(rl, onDirty),
    onDegraded: async (summary) => {
      process.stdout.write(`\n${summary}\n`);
      const ans = (await rl.question("[A]ccept / [B]bort [Enter=accept]: "))
        .trim()
        .toLowerCase();
      if (ans === "b" || ans === "abort") return "abort";
      return "accept";
    },
    onReviewerExhausted: async (diag?: SeatDiagnostics) => {
      process.stdout.write(
        `\nBoth reviewers failed after a whole-round retry.\n`,
      );
      // Per-seat diagnostics (Issue #52).
      if (diag !== undefined) {
        for (const [seatKey, seat] of [
          ["reviewer_a", diag.reviewer_a],
          ["reviewer_b", diag.reviewer_b],
        ] as const) {
          if (seat.errorDetail !== undefined) {
            const truncated = seat.errorDetail.message.slice(0, 120);
            process.stdout.write(
              `  ${seatKey} (${seat.vendor}): ${seat.errorDetail.reason} — "${truncated}"\n`,
            );
          } else {
            process.stdout.write(
              `  ${seatKey} (${seat.vendor}): no detail available\n`,
            );
          }
        }
      }
      const ans = (await rl.question("[C]ontinue / [A]bort [Enter=abort]: "))
        .trim()
        .toLowerCase();
      if (ans === "c" || ans === "continue") return "continue";
      return "abort";
    },
    onPushConsent: async (payload) => {
      process.stdout.write(`\nFirst push in this repo — consent required.\n`);
      process.stdout.write(`  remote: ${payload.remoteName}\n`);
      process.stdout.write(`  remote URL: ${payload.remoteUrl}\n`);
      process.stdout.write(`  branch: ${payload.targetBranch}\n`);
      process.stdout.write(`  default branch: ${payload.defaultBranch}\n`);
      process.stdout.write(`  ${describePrCapability(payload.prCapability)}\n`);
      const ans = (
        await rl.question(
          "[A]ccept (persist) / [R]efuse (persist) [Enter=refuse]: ",
        )
      )
        .trim()
        .toLowerCase();
      if (ans === "a" || ans === "accept") return "accept";
      return "refuse";
    },
  };
}

async function runIterateCommand(rest: readonly string[]) {
  const parsed = parseIterateArgs(rest);
  if (typeof parsed === "string") {
    return { exitCode: 1, stdout: "", stderr: `${parsed}\n\n${USAGE}` };
  }
  const adapters = buildReviewLoopAdapters();
  const pushOptions: PushOptions = {
    remote: parsed.remote,
    noPush: parsed.noPush,
  };
  try {
    const result = await runIterate({
      cwd: process.cwd(),
      slug: parsed.slug,
      now: new Date().toISOString(),
      resolvers: interactiveIterateResolvers(parsed.onDirty),
      adapters,
      pushOptions,
      quiet: parsed.quiet,
      ...(parsed.rounds !== undefined ? { maxRounds: parsed.rounds } : {}),
      ...(parsed.maxSessionWallClockMs !== undefined
        ? { maxSessionWallClockMs: parsed.maxSessionWallClockMs }
        : {}),
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    // #114: the non-TTY manual-edit resolver rejects with an Error so
    // iterate exits cleanly instead of readline-deadlocking. Translate
    // the rejection to an exit-1 CliResult with the actionable message.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("--on-dirty")) {
      return { exitCode: 1, stdout: "", stderr: `${msg}\n` };
    }
    throw err;
  }
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

// ---------- publish ----------

interface PublishArgs {
  readonly slug: string;
  readonly noLint: boolean;
  readonly remote: string;
}

function parsePublishArgs(argv: readonly string[]): PublishArgs | string {
  let slug: string | null = null;
  let noLint = false;
  let remote = "origin";
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === undefined) continue;
    if (t === "--no-lint") {
      noLint = true;
      continue;
    }
    if (t === "--remote") {
      const v = argv[i + 1];
      i += 1;
      if (v !== undefined && v.length > 0) remote = v;
      continue;
    }
    if (t.startsWith("--remote=")) {
      remote = t.slice("--remote=".length);
      continue;
    }
    if (t.startsWith("--")) continue;
    slug ??= t;
  }
  if (slug === null || slug.length === 0) {
    return "samospec publish: missing <slug>";
  }
  return { slug, noLint, remote };
}

async function runPublishCommand(rest: readonly string[]) {
  const parsed = parsePublishArgs(rest);
  if (typeof parsed === "string") {
    return { exitCode: 1, stdout: "", stderr: `${parsed}\n\n${USAGE}` };
  }
  return runPublish({
    cwd: process.cwd(),
    slug: parsed.slug,
    now: new Date().toISOString(),
    remote: parsed.remote,
    noLint: parsed.noLint,
  });
}
