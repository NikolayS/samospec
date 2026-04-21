// Copyright 2026 Nikolay Samokhvalov.

// SPEC §7 + §11: the real Claude adapter (lead seat).
//
// - Spawns the `claude` CLI via Bun.spawn using the minimal-env +
//   non-interactive flag helpers from `./spawn.ts`.
// - Non-interactive flags: `--print --dangerously-skip-permissions`
//   (documented in spawn.ts; the installed target is Claude CLI v2.1.x
//   which accepts both).
// - Minimal env: `HOME`, `PATH`, `TMPDIR`, plus `ANTHROPIC_API_KEY`
//   when present. Everything else is dropped.
// - Structured output: stdout captured, passed through
//   `preParseJson`, then zod-validated. ONE repair retry on schema
//   violation per call; then terminal.
// - Timeout: capped retry policy (base → +50% → base → terminal)
//   via `runWithCappedRetry`.
// - `usage: null` path honored when CLI output doesn't report it,
//   or under subscription auth.
// - `revise()` emits the full SPEC.md text each round (not a patch);
//   `ready` + `rationale` are inline JSON fields.
// - Pinned default model: `claude-opus-4-7`.
//
// Tests never shell out to the real `claude`. Work-call tests inject
// the fake-CLI harness via the `spawn` dependency.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { detectSubscriptionAuth } from "./auth-status.ts";
import { type ClaudeResolver } from "./claude-resolver.ts";
import { preParseJson } from "./json-parse.ts";
import {
  CLAUDE_NON_INTERACTIVE_FLAGS,
  spawnCli,
  type SpawnCliInput,
  type SpawnCliResult,
} from "./spawn.ts";
import { runWithCappedRetry, type AttemptResult } from "./timeout.ts";
import {
  type Adapter,
  type AskInput,
  type AskOutput,
  type AuthStatus,
  type CritiqueInput,
  type CritiqueOutput,
  type DetectResult,
  type EffortLevel,
  type ModelInfo,
  type ReviseInput,
  type ReviseOutput,
  AskInputSchema,
  AskOutputSchema,
  CritiqueInputSchema,
  CritiqueOutputSchema,
  ReviseInputSchema,
  ReviseOutputSchema,
} from "./types.ts";

// ---------- constants ----------

const CLAUDE_VENDOR = "claude";
const CLAUDE_BINARY_NAME = "claude";
const CLAUDE_AUTH_ENV_KEYS: readonly string[] = ["ANTHROPIC_API_KEY"];

// SPEC §11 pinned model + fallback.
const DEFAULT_MODELS: readonly ModelInfo[] = [
  { id: "claude-opus-4-7", family: "claude" },
  { id: "claude-sonnet-4-6", family: "claude" },
];

const DEFAULT_MODEL_ID = "claude-opus-4-7";

// ---------- adapter options / dependency injection ----------

export type SpawnFn = typeof spawnCli;

export interface ClaudeAdapterOpts {
  /** Binary name (or absolute path) to exec. Default: "claude". */
  readonly binary?: string;
  /**
   * Host env snapshot for env derivation and PATH-based binary resolution.
   * Defaults to process.env. Tests inject a deterministic map.
   */
  readonly host?: Readonly<Record<string, string | undefined>>;
  /**
   * spawnCli replacement for tests. Defaults to `./spawn.ts` spawnCli.
   */
  readonly spawn?: SpawnFn;
  /**
   * Models override. Defaults to pinned `claude-opus-4-7` + fallback.
   */
  readonly models?: readonly ModelInfo[];
  /**
   * Default model id passed through to CLI invocations. Default
   * `claude-opus-4-7`.
   */
  readonly defaultModel?: string;
  /**
   * Shared Claude fallback-chain resolver (SPEC §11). When supplied,
   * the `--model` pin at every work-call spawn comes from
   * `resolver.getCurrentModel()` instead of the fixed `defaultModel`.
   * The resolver is shared between the lead and the Reviewer B
   * adapter to express the **coupled fallback** linkage: a transition
   * to sonnet on one side is visible on the other.
   */
  readonly resolver?: ClaudeResolver;
}

// ---------- binary discovery ----------

function resolveBinaryPath(
  host: Readonly<Record<string, string | undefined>>,
  binary: string,
): string | null {
  // Absolute-ish path: respect it as-is.
  if (binary.includes("/")) {
    return existsSync(binary) ? binary : null;
  }
  const pathVar = host["PATH"];
  if (typeof pathVar !== "string" || pathVar.length === 0) {
    return null;
  }
  for (const segment of pathVar.split(":")) {
    if (segment === "") continue;
    const candidate = join(segment, binary);
    try {
      if (existsSync(candidate)) {
        const st = statSync(candidate);
        if (st.isFile()) {
          return candidate;
        }
      }
    } catch {
      // permission denied etc.; keep looking
    }
  }
  return null;
}

function parseVersionOutput(raw: string): string {
  // Accept anything with at least a semver-ish "N.N.N"; fall back to
  // the first trimmed line. We do not fail detection on weird output.
  const trimmed = raw.trim();
  if (trimmed === "") return "unknown";
  const semverMatch = /\d+\.\d+(?:\.\d+)?/.exec(trimmed);
  if (semverMatch !== null) {
    return semverMatch[0];
  }
  const firstLine = trimmed.split("\n")[0];
  return firstLine ?? "unknown";
}

// ---------- ClaudeAdapter ----------

export class ClaudeAdapter implements Adapter {
  readonly vendor: string = CLAUDE_VENDOR;

  protected readonly binary: string;
  protected readonly host: Readonly<Record<string, string | undefined>>;
  protected readonly spawnFn: SpawnFn;
  protected readonly modelList: readonly ModelInfo[];
  protected readonly defaultModel: string;
  protected readonly resolver: ClaudeResolver | null;

  constructor(opts: ClaudeAdapterOpts = {}) {
    this.binary = opts.binary ?? CLAUDE_BINARY_NAME;
    this.host =
      opts.host ?? (process.env as Record<string, string | undefined>);
    this.spawnFn = opts.spawn ?? spawnCli;
    this.modelList = opts.models ?? DEFAULT_MODELS;
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL_ID;
    this.resolver = opts.resolver ?? null;
  }

  /**
   * Current model id the adapter will pin at spawn time. Reads through
   * the shared resolver when present, falling back to the constructor
   * `defaultModel`. Exposed for tests + state.json snapshotting.
   */
  currentModelId(): string {
    return this.resolver !== null
      ? this.resolver.getCurrentModel()
      : this.defaultModel;
  }

  // ---------- lifecycle ----------

  detect(): Promise<DetectResult> {
    const resolved = resolveBinaryPath(this.host, this.binary);
    if (resolved === null) {
      return Promise.resolve({ installed: false });
    }
    return this.probeVersion(resolved);
  }

  private async probeVersion(resolvedPath: string): Promise<DetectResult> {
    const r = await this.spawnFn({
      cmd: [resolvedPath, "--version"],
      stdin: "",
      env: {},
      timeoutMs: 5_000,
      extraAllowedEnvKeys: CLAUDE_AUTH_ENV_KEYS,
      host: this.host,
    });
    if (!r.ok || r.exitCode !== 0) {
      // Binary exists but couldn't run; treat as installed-but-unknown.
      return {
        installed: true,
        version: "unknown",
        path: resolvedPath,
      };
    }
    return {
      installed: true,
      version: parseVersionOutput(r.stdout),
      path: resolvedPath,
    };
  }

  // ---------- auth ----------

  auth_status(): Promise<AuthStatus> {
    const authKey = CLAUDE_AUTH_ENV_KEYS[0];
    const apiKey = authKey !== undefined ? this.host[authKey] : undefined;
    const hasApiKey = typeof apiKey === "string" && apiKey.length > 0;

    // If no binary, we cannot be authenticated.
    const resolved = resolveBinaryPath(this.host, this.binary);
    if (resolved === null) {
      return Promise.resolve({ authenticated: false });
    }

    // Deterministic baseline: API key env var implies authenticated.
    // Subscription-auth mode (no API key but authenticated via keychain)
    // is reported as authenticated + subscription_auth=true.
    //
    // We do not probe the real CLI for keychain auth here — that would
    // require unsandboxed keychain access in tests. Instead, the
    // heuristic is:
    //   - API key present -> authenticated, subscription_auth=false
    //   - No API key, binary installed -> authenticated=true,
    //     subscription_auth=true (subscription/keychain assumed)
    //
    // This matches the SPEC §11 subscription-auth escape: a running
    // `claude` CLI without ANTHROPIC_API_KEY must be using the
    // subscription keychain, because that is the only other
    // authenticated mode the CLI supports.
    const authenticated = true;
    const subscription_auth = detectSubscriptionAuth({
      vendor: CLAUDE_VENDOR,
      authenticated,
      env: this.host,
    });
    if (hasApiKey) {
      return Promise.resolve({
        authenticated,
        subscription_auth: false,
      });
    }
    // OAuth (subscription) mode — no API key in env. The CLI inherits
    // the browser OAuth session. Work calls proceed normally; token
    // accounting is unavailable (SPEC §11 subscription-auth escape).
    return Promise.resolve({
      authenticated,
      subscription_auth,
    });
  }

  supports_structured_output(): boolean {
    return true;
  }

  supports_effort(_level: EffortLevel): boolean {
    return true;
  }

  models(): Promise<readonly ModelInfo[]> {
    return Promise.resolve(this.modelList);
  }

  // ---------- work calls ----------

  async ask(input: AskInput): Promise<AskOutput> {
    AskInputSchema.parse(input);
    const prompt = buildAskPrompt(input);
    const raw = await this.runWithRetries({
      prompt,
      timeoutMs: input.opts.timeout,
      effort: input.opts.effort,
      structured: true,
    });
    const parsed = parseAskJson(raw, input.opts.effort);
    return AskOutputSchema.parse(parsed);
  }

  async critique(input: CritiqueInput): Promise<CritiqueOutput> {
    CritiqueInputSchema.parse(input);
    const prompt = buildCritiquePrompt(input);
    const raw = await this.runWithRetries({
      prompt,
      timeoutMs: input.opts.timeout,
      effort: input.opts.effort,
      structured: true,
    });
    const parsed = parseCritiqueJson(raw, input.opts.effort);
    return CritiqueOutputSchema.parse(parsed);
  }

  async revise(input: ReviseInput): Promise<ReviseOutput> {
    ReviseInputSchema.parse(input);
    const prompt = buildRevisePrompt(input);
    const raw = await this.runWithRetries({
      prompt,
      timeoutMs: input.opts.timeout,
      effort: input.opts.effort,
      structured: true,
    });
    const parsed = parseReviseJson(raw, input.opts.effort);
    return ReviseOutputSchema.parse(parsed);
  }

  // ---------- shared spawn + retry ----------

  /**
   * Run one work-call via the CLI. Enforces:
   * - capped timeout retry (base → +50% → base → terminal)
   * - ONE schema-violation repair retry per timeout-attempt
   * - non-interactive flags
   * - minimal env
   *
   * Returns the raw stdout string for the caller to JSON-parse.
   */
  private async runWithRetries(args: {
    prompt: string;
    timeoutMs: number;
    effort: EffortLevel;
    structured: boolean;
  }): Promise<string> {
    const resolvedBinary =
      resolveBinaryPath(this.host, this.binary) ?? this.binary;

    // We track whether any attempt saw a rate-limit-shaped error so we
    // can surface the `rate_limit` flag on the terminal error. Callers
    // (review loop, Sprint 3 #4) use this to soft-degrade the seat
    // rather than treating it as a plain timeout/retry exhaustion.
    let sawRateLimit = false;
    const outcome = await runWithCappedRetry<string>(
      async (ctx) => {
        const single = await this.runSingleAttempt({
          binary: resolvedBinary,
          prompt: args.prompt,
          timeoutMs: ctx.timeout,
          effort: args.effort,
          structured: args.structured,
        });
        if (!single.ok && single.reason === "timeout") {
          const detail = single.detail;
          if (detail !== undefined && isRateLimitDetail(detail)) {
            sawRateLimit = true;
          }
        }
        return single;
      },
      { baseTimeoutMs: args.timeoutMs },
    );

    if (outcome.ok) {
      return outcome.value;
    }

    const base: ClaudeAdapterErrorPayload = {
      kind: "terminal",
      reason: outcome.reason,
      retryable: outcome.reason === "timeout",
      attempts: outcome.attempts,
    };
    const payload: ClaudeAdapterErrorPayload = {
      ...base,
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      ...(sawRateLimit ? { rate_limit: true } : {}),
    };
    throw new ClaudeAdapterError(payload);
  }

  private async runSingleAttempt(args: {
    binary: string;
    prompt: string;
    timeoutMs: number;
    effort: EffortLevel;
    structured: boolean;
  }): Promise<AttemptResult<string>> {
    // First call.
    const first = await this.spawnOnce({
      binary: args.binary,
      prompt: args.prompt,
      timeoutMs: args.timeoutMs,
      effort: args.effort,
    });

    if (!first.ok) {
      if (first.reason === "timeout") {
        return { ok: false, reason: "timeout" };
      }
      return {
        ok: false,
        reason: "other",
        detail: `spawn_error: ${first.detail ?? ""}`,
      };
    }
    if (first.exitCode !== 0) {
      return classifyExit(first.exitCode, first.stderr);
    }

    if (!args.structured) {
      return { ok: true, value: first.stdout };
    }

    // Structured: run pre-parser; on schema violation, ONE repair
    // retry within this single timeout-attempt.
    const parsed = preParseJson(first.stdout);
    if (parsed.ok) {
      return { ok: true, value: first.stdout };
    }

    const repairPrompt = buildRepairPrompt(args.prompt, first.stdout);
    const repair = await this.spawnOnce({
      binary: args.binary,
      prompt: repairPrompt,
      timeoutMs: args.timeoutMs,
      effort: args.effort,
    });

    if (!repair.ok) {
      if (repair.reason === "timeout") {
        return { ok: false, reason: "timeout" };
      }
      return {
        ok: false,
        reason: "other",
        detail: `spawn_error: ${repair.detail ?? ""}`,
      };
    }
    if (repair.exitCode !== 0) {
      return classifyExit(repair.exitCode, repair.stderr);
    }

    const parsedRepair = preParseJson(repair.stdout);
    if (!parsedRepair.ok) {
      return {
        ok: false,
        reason: "schema_violation",
        detail: parsedRepair.error.message,
      };
    }
    return { ok: true, value: repair.stdout };
  }

  private async spawnOnce(args: {
    binary: string;
    prompt: string;
    timeoutMs: number;
    effort: EffortLevel;
  }): Promise<SpawnCliResult> {
    const cmd: readonly string[] = [
      args.binary,
      ...CLAUDE_NON_INTERACTIVE_FLAGS,
      "--model",
      this.currentModelId(),
    ];
    const input: SpawnCliInput = {
      cmd,
      stdin: args.prompt,
      env: {},
      timeoutMs: args.timeoutMs,
      extraAllowedEnvKeys: CLAUDE_AUTH_ENV_KEYS,
      host: this.host,
    };
    return await this.spawnFn(input);
  }
}

// ---------- baseline section prompt helper ----------

/**
 * Build the mandatory baseline sections instruction block.
 * Sections in `skipList` (case-insensitive match against canonical names)
 * are excluded from the mandatory list.
 *
 * Returns an empty string when all nine sections are skipped (edge case).
 */
export function buildBaselineSectionsBlock(
  skipList: readonly string[] = [],
): string {
  const skipLower = skipList.map((s) => s.toLowerCase().trim());

  const ALL_SECTIONS: readonly { name: string; instruction: string }[] = [
    {
      name: "version header",
      instruction:
        "(1) Version header at top — start at v0.1 and bump each round " +
        "(e.g. `# <name> — SPEC v0.1`).",
    },
    {
      name: "goal",
      instruction:
        "(2) Goal & why it's needed — explicit 'why this exists' framing, " +
        "not just 'Purpose'.",
    },
    {
      name: "user stories",
      instruction:
        "(3) User stories — at least 3, each with persona + action + outcome " +
        "(≥3 minimum; used for manual testing).",
    },
    {
      name: "architecture",
      instruction:
        "(4) Architecture — components, boundaries, key abstractions.",
    },
    {
      name: "implementation details",
      instruction:
        "(5) Implementation details — data flow, state transitions, key " +
        "algorithms.",
    },
    {
      name: "tests",
      instruction:
        "(6) Tests plan — CI tests needed AND explicit red/green TDD call-out " +
        "for which pieces are built test-first.",
    },
    {
      name: "team",
      instruction:
        "(7) Team — list of veteran experts to hire (count + skill labels, " +
        "e.g. 'Veteran CLI systems engineer (1)').",
    },
    {
      name: "sprints",
      instruction:
        "(8) Implementation plan — organized in multiple sprints with " +
        "parallelization and ordering between team members.",
    },
    {
      name: "changelog",
      instruction:
        "(9) Embedded Changelog — version history mirroring changelog.md, " +
        "one line per change.",
    },
  ];

  const mandatory = ALL_SECTIONS.filter(
    (s) => !skipLower.includes(s.name.toLowerCase()),
  );

  if (mandatory.length === 0) return "";

  const sectionLines = mandatory.map((s) => s.instruction).join(" ");
  const skippedNote =
    skipList.length > 0
      ? ` (sections excluded via --skip: ${skipList.join(", ")})`
      : "";

  return (
    `\n\nMANDATORY BASELINE SECTIONS${skippedNote}: Your SPEC.md MUST ` +
    `include all of the following sections unless the user opted out. ` +
    sectionLines +
    ` Additional topic-specific sections are always permitted.`
  );
}

// ---------- idea-precedence framing (SPEC §7 v0.4.0 / Issue #85) ----------

/**
 * Build the idea-precedence block that tells the lead (and Reviewer B)
 * that --idea is the AUTHORITATIVE source of semantics. The slug is a
 * filesystem identifier only — the model must NOT infer project meaning
 * from it.
 *
 * Returns an empty string when `idea` is absent (backward compatible).
 *
 * Exact wording is tested in tests/adapter/lead-prompt-idea-precedence.test.ts
 * — change carefully.
 */
export function buildIdeaPrecedenceBlock(opts: {
  idea?: string;
  slug?: string;
}): string {
  if (opts.idea === undefined || opts.idea.trim().length === 0) {
    return "";
  }
  const slugLine =
    opts.slug !== undefined && opts.slug.trim().length > 0
      ? `\n## Project slug (filesystem-safe identifier only — DO NOT infer semantics from it)\n${opts.slug}\n`
      : "";
  return (
    `\n## Project idea (AUTHORITATIVE — this is what the tool does)\n${opts.idea}\n` +
    slugLine +
    "\nIf the slug and the idea appear to conflict, the IDEA wins. " +
    'If the idea contains "NOT X" / "this is NOT a Y" disclaimers, ' +
    "honor them strictly — do not silently re-introduce the rejected " +
    "framing in any section.\n"
  );
}

// ---------- prompt builders (exported for tests) ----------

export function buildAskPrompt(input: AskInput): string {
  const ctx = input.context === "" ? "" : `\n\nContext:\n${input.context}\n`;
  const ideaOpts: { idea?: string; slug?: string } = {};
  if (typeof input.idea === "string" && input.idea.length > 0)
    ideaOpts.idea = input.idea;
  if (typeof input.slug === "string" && input.slug.length > 0)
    ideaOpts.slug = input.slug;
  const ideaBlock = buildIdeaPrecedenceBlock(ideaOpts);
  return (
    "You are the samospec lead. Respond ONLY with a JSON object matching " +
    'the schema { "answer": string, "usage": null, "effort_used": ' +
    `"${input.opts.effort}" }. Do not wrap in code fences.` +
    ideaBlock +
    ctx +
    `\n\nQuestion:\n${input.prompt}\n`
  );
}

export function buildCritiquePrompt(input: CritiqueInput): string {
  return (
    "You are the samospec reviewer. Return ONLY a JSON object matching " +
    'the review-taxonomy schema: { "findings": Array<{ "category": ' +
    'string, "text": string, "severity": "major"|"minor" }>, "summary":' +
    ' string, "suggested_next_version": string, "usage": null, ' +
    `"effort_used": "${input.opts.effort}" }. Do not wrap in code fences.` +
    `\n\nGuidelines:\n${input.guidelines}\n\nSpec:\n${input.spec}\n`
  );
}

export function buildRevisePrompt(input: ReviseInput): string {
  const baselineSections = buildBaselineSectionsBlock(input.skipSections ?? []);
  const reviseIdeaOpts: { idea?: string; slug?: string } = {};
  if (typeof input.idea === "string" && input.idea.length > 0)
    reviseIdeaOpts.idea = input.idea;
  if (typeof input.slug === "string" && input.slug.length > 0)
    reviseIdeaOpts.slug = input.slug;
  const ideaBlock = buildIdeaPrecedenceBlock(reviseIdeaOpts);
  return (
    "You are the samospec lead. Emit the FULL revised SPEC.md text — " +
    'not a patch. Return ONLY a JSON object: { "spec": <full text>, ' +
    '"ready": boolean, "rationale": string, ' +
    '"decisions": [{ "finding_id"?: string, "category": string, ' +
    '"verdict": "accepted"|"rejected"|"deferred", "rationale": string }], ' +
    '"usage": null, ' +
    `"effort_used": "${input.opts.effort}" }. Do not wrap in code ` +
    "fences. For each finding the reviewers raised, emit a decision " +
    "object in the decisions array with a one-sentence rationale. " +
    "Verdict options: accepted (applied to the spec), rejected " +
    "(did not apply, with reason), deferred (punted to a later version)." +
    ideaBlock +
    baselineSections +
    `\n\nCurrent spec:\n${input.spec}\n\nReviews (JSON):\n` +
    `${JSON.stringify(input.reviews)}\n\nDecisions so far (JSON):\n` +
    `${JSON.stringify(input.decisions_history)}\n`
  );
}

function buildRepairPrompt(originalPrompt: string, badOutput: string): string {
  return (
    "Your previous response was not valid JSON per the required schema." +
    " Re-emit ONLY the required JSON object. No prose, no code fences. " +
    "Previous invalid output was:\n" +
    badOutput +
    "\n\nRe-attempt the original request:\n" +
    originalPrompt
  );
}

// ---------- response parsing ----------

function parseAskJson(raw: string, requestedEffort: EffortLevel): unknown {
  const parsed = preParseJson<Record<string, unknown>>(raw);
  if (!parsed.ok) {
    throw new ClaudeAdapterError({
      kind: "terminal",
      reason: "schema_violation",
      detail: parsed.error.message,
    });
  }
  return normalizeUsageAndEffort(parsed.value, requestedEffort);
}

function parseCritiqueJson(raw: string, requestedEffort: EffortLevel): unknown {
  const parsed = preParseJson<Record<string, unknown>>(raw);
  if (!parsed.ok) {
    throw new ClaudeAdapterError({
      kind: "terminal",
      reason: "schema_violation",
      detail: parsed.error.message,
    });
  }
  return normalizeUsageAndEffort(parsed.value, requestedEffort);
}

function parseReviseJson(raw: string, requestedEffort: EffortLevel): unknown {
  const parsed = preParseJson<Record<string, unknown>>(raw);
  if (!parsed.ok) {
    throw new ClaudeAdapterError({
      kind: "terminal",
      reason: "schema_violation",
      detail: parsed.error.message,
    });
  }
  return normalizeUsageAndEffort(parsed.value, requestedEffort);
}

function normalizeUsageAndEffort(
  value: Record<string, unknown>,
  requestedEffort: EffortLevel,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  if (!("usage" in out)) {
    out["usage"] = null;
  }
  if (!("effort_used" in out)) {
    out["effort_used"] = requestedEffort;
  }
  return out;
}

// ---------- error classification ----------

// Stable token used in AttemptFail.detail strings to signal that the
// underlying CLI error was rate-limit-shaped. `runWithRetries` inspects
// this token to set the `rate_limit` flag on the outward error payload.
// Downstream (review loop, Sprint 3 #4) consumes the flag for
// soft-degrade (SPEC §7 rate-limit sharing).
const RATE_LIMIT_DETAIL_TOKEN = "rate_limit";

function isRateLimitStderr(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("rate-limit") ||
    /\b429\b/.test(stderr)
  );
}

function isRateLimitDetail(detail: string): boolean {
  return detail.includes(RATE_LIMIT_DETAIL_TOKEN);
}

function classifyExit(exitCode: number, stderr: string): AttemptResult<string> {
  // Stderr-heuristic classification per SPEC §7 failure classes.
  // Non-zero exit is terminal unless stderr matches a known retryable
  // pattern (rate limit, network, 5xx).
  const lower = stderr.toLowerCase();
  const rateLimited = isRateLimitStderr(stderr);
  const retryable =
    rateLimited ||
    lower.includes("network error") ||
    lower.includes("timeout") ||
    /\b5\d{2}\b/.test(stderr);
  const baseDetail = `exit ${String(exitCode)}: ${stderr.trim()}`;
  const detail = rateLimited
    ? `${RATE_LIMIT_DETAIL_TOKEN} | ${baseDetail}`
    : baseDetail;
  return {
    ok: false,
    reason: retryable ? "timeout" : "other",
    detail,
  };
}

// ---------- error type ----------

export interface ClaudeAdapterErrorPayload {
  readonly kind: "terminal";
  readonly reason:
    | "timeout"
    | "schema_violation"
    | "other"
    | "claude_cli_auth_failed";
  readonly detail?: string;
  readonly attempts?: number;
  /**
   * SPEC §7 failure classification. `true` when the underlying cause
   * was a retryable class (rate-limit, network, 5xx, timeout) whose
   * capped-retry budget was exhausted. The outer `kind` remains
   * `terminal` after exhaustion, but the review loop uses `retryable`
   * + `rate_limit` for soft-degrade decisions.
   */
  readonly retryable?: boolean;
  /**
   * SPEC §7 rate-limit sharing: `true` iff at least one attempt saw a
   * rate-limit-shaped error (stderr match or 429). Surfaces to the
   * review loop so Reviewer B can be soft-degraded without halting
   * the round (lead + Reviewer B share the Claude account budget).
   */
  readonly rate_limit?: boolean;
}

export class ClaudeAdapterError extends Error {
  readonly payload: ClaudeAdapterErrorPayload;
  constructor(payload: ClaudeAdapterErrorPayload) {
    const detail = payload.detail ?? "";
    super(`Claude adapter ${payload.reason}: ${detail}`);
    this.name = "ClaudeAdapterError";
    this.payload = payload;
  }
}
