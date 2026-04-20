// Copyright 2026 Nikolay Samokhvalov.

// SPEC §7 + §11: the real Codex adapter (Reviewer A seat).
//
// - Spawns the `codex` CLI via Bun.spawn using the minimal-env +
//   non-interactive flag helpers from `./spawn.ts`.
// - Non-interactive flags: `codex exec ...` subcommand (CODEX_NON_INTERACTIVE_FLAGS
//   in spawn.ts). `exec` is the installed Codex CLI's headless mode:
//   it reads the prompt from stdin, does not spawn a TTY, and does not
//   hang on a permission prompt. `doctor` additionally runs
//   `codex --version` to verify a TTY-less spawn works.
// - Minimal env: `HOME`, `PATH`, `TMPDIR`, plus `OPENAI_API_KEY`
//   when present. Everything else is dropped.
// - Structured output: stdout captured, passed through
//   `preParseJson`, then zod-validated. ONE repair retry on schema
//   violation per call; then terminal.
// - Timeout: capped retry policy (base → +50% → base → terminal)
//   via `runWithCappedRetry`.
// - Persona system prompt on `critique()`: "paranoid security/ops
//   engineer" with an explicit advisory weighting toward
//   `missing-risk`, `weak-implementation`, `unnecessary-scope` (SPEC §7
//   Model roles). Literal wording per issue #23.
// - Effort mapping per SPEC §11: logical max/high → reasoning_effort
//   high, medium → medium, low → low, off → minimal. Passed as a
//   `--reasoning_effort <level>` flag on every work call.
// - Pinned default model: `gpt-5.1-codex-max`. Fallback chain on
//   model-unavailable failure: `gpt-5.1-codex-max → gpt-5.1-codex →
//   terminal` (SPEC §11). Fallback is triggered by a stderr heuristic
//   on non-zero exit; resolved model is preserved within a call but
//   not across calls (callers observe via `state.json` at round start).
// - `usage: null` path honored when CLI output doesn't report it or
//   under subscription auth.
// - Subscription-auth heuristic: ChatGPT-login (no OPENAI_API_KEY) →
//   subscription_auth=true; API-key → false. Matches the Claude
//   Max/Pro escape in auth-status.ts.
//
// Tests never shell out to the real `codex`. Work-call tests inject
// the fake-CLI harness via the `spawn` dependency.

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { detectSubscriptionAuth } from "./auth-status.ts";
import { preParseJson } from "./json-parse.ts";
import {
  CODEX_NON_INTERACTIVE_FLAGS,
  spawnCli,
  type SpawnCliInput,
  type SpawnCliResult,
} from "./spawn.ts";
import { computeAttemptTimeouts } from "./timeout.ts";

// Internal fail reason covering the Codex fallback sentinel plus the
// standard failure classes. The adapter-level CodexAdapterError
// surfaces every case (including `model_unavailable`) directly — the
// public interface does not lose information.
interface CodexAttemptFail {
  readonly ok: false;
  readonly reason: CodexAdapterErrorReason;
  readonly detail?: string;
}
type CodexAttemptResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      /** True when the account-default tier (no --model flag) was used. */
      readonly accountDefault?: boolean;
    }
  | CodexAttemptFail;
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

const CODEX_VENDOR = "codex";
const CODEX_BINARY_NAME = "codex";
const CODEX_AUTH_ENV_KEYS: readonly string[] = ["OPENAI_API_KEY"];

// SPEC §11 pinned model + fallback chain. First entry is the default;
// subsequent entries form the ordered fallback chain.
const DEFAULT_MODELS: readonly ModelInfo[] = [
  { id: "gpt-5.1-codex-max", family: "codex" },
  { id: "gpt-5.1-codex", family: "codex" },
];

const DEFAULT_MODEL_ID = "gpt-5.1-codex-max";

// Sentinel value appended to the runtime fallback chain to represent
// the account-default tier: codex is invoked with --model omitted so
// it falls back to whatever the ChatGPT account supports. Only reached
// when every explicit pin has raised model_unavailable (#54).
const ACCOUNT_DEFAULT_SENTINEL = "__account_default__" as const;

// SPEC §11 effort-level table (Codex / OpenAI-family column).
const EFFORT_TO_REASONING: Readonly<Record<EffortLevel, string>> = {
  max: "high",
  high: "high",
  medium: "medium",
  low: "low",
  off: "minimal",
};

// Persona + taxonomy weighting (SPEC §7 Model roles). Literal wording
// is pinned by test; issue #23 forbids paraphrasing.
const CODEX_CRITIQUE_PERSONA_PREFIX =
  "You are a paranoid security/ops engineer reviewing this spec. " +
  "Focus especially on missing-risk, weak-implementation, and " +
  "unnecessary-scope. You may surface findings in other categories " +
  "when warranted, but weight your effort toward these.";

// ---------- adapter options / dependency injection ----------

export type SpawnFn = typeof spawnCli;

export interface CodexAdapterOpts {
  /** Binary name (or absolute path) to exec. Default: "codex". */
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
   * Models override. Defaults to pinned `gpt-5.1-codex-max` +
   * `gpt-5.1-codex` fallback. Order matters: the first entry is the
   * preferred model; subsequent entries are the fallback chain.
   */
  readonly models?: readonly ModelInfo[];
  /**
   * Default model id. Used as the first entry of the runtime fallback
   * chain. Default `gpt-5.1-codex-max`.
   */
  readonly defaultModel?: string;
  /**
   * When true (the default), append an implicit account-default tier
   * after all explicit model pins. The tier re-invokes codex with
   * --model omitted, letting the ChatGPT account pick its supported
   * default. Set to false to force explicit pins only (#54).
   */
  readonly accountDefaultFallback?: boolean;
}

// ---------- binary discovery ----------

function resolveBinaryPath(
  host: Readonly<Record<string, string | undefined>>,
  binary: string,
): string | null {
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
  const trimmed = raw.trim();
  if (trimmed === "") return "unknown";
  const semverMatch = /\d+\.\d+(?:\.\d+)?/.exec(trimmed);
  if (semverMatch !== null) {
    return semverMatch[0];
  }
  const firstLine = trimmed.split("\n")[0];
  return firstLine ?? "unknown";
}

// ---------- CodexAdapter ----------

export class CodexAdapter implements Adapter {
  readonly vendor: string = CODEX_VENDOR;

  private readonly binary: string;
  private readonly host: Readonly<Record<string, string | undefined>>;
  private readonly spawnFn: SpawnFn;
  private readonly modelList: readonly ModelInfo[];
  private readonly defaultModel: string;
  private readonly accountDefaultFallback: boolean;

  constructor(opts: CodexAdapterOpts = {}) {
    this.binary = opts.binary ?? CODEX_BINARY_NAME;
    this.host =
      opts.host ?? (process.env as Record<string, string | undefined>);
    this.spawnFn = opts.spawn ?? spawnCli;
    this.modelList = opts.models ?? DEFAULT_MODELS;
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL_ID;
    this.accountDefaultFallback = opts.accountDefaultFallback ?? true;
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
      extraAllowedEnvKeys: CODEX_AUTH_ENV_KEYS,
      host: this.host,
    });
    if (!r.ok || r.exitCode !== 0) {
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
    const authKey = CODEX_AUTH_ENV_KEYS[0];
    const apiKey = authKey !== undefined ? this.host[authKey] : undefined;
    const hasApiKey = typeof apiKey === "string" && apiKey.length > 0;

    // If no binary on PATH, we cannot be authenticated.
    const resolved = resolveBinaryPath(this.host, this.binary);
    if (resolved === null) {
      return Promise.resolve({ authenticated: false });
    }

    // Deterministic baseline: binary installed implies the CLI is in
    // one of the two authenticated modes (API key or ChatGPT login).
    // The real CLI will reject unauthenticated calls at runtime; the
    // Sprint 3 heuristic mirrors the Claude adapter's env-var approach.
    const authenticated = true;
    const subscription_auth = detectSubscriptionAuth({
      vendor: CODEX_VENDOR,
      authenticated,
      env: this.host,
    });
    if (hasApiKey) {
      return Promise.resolve({
        authenticated,
        subscription_auth: false,
      });
    }
    // OAuth (ChatGPT subscription login) mode — no API key in env.
    // The CLI inherits the browser OAuth session. Work calls proceed
    // normally; token accounting is unavailable (SPEC §11 escape).
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
    const { raw, accountDefault } = await this.runWithRetries({
      prompt,
      timeoutMs: input.opts.timeout,
      effort: input.opts.effort,
      structured: true,
    });
    const parsed = parseStructuredJson(raw, input.opts.effort);
    const base = AskOutputSchema.parse(parsed);
    return accountDefault ? { ...base, account_default: true } : base;
  }

  async critique(input: CritiqueInput): Promise<CritiqueOutput> {
    CritiqueInputSchema.parse(input);
    const prompt = buildCritiquePrompt(input);
    const { raw } = await this.runWithRetries({
      prompt,
      timeoutMs: input.opts.timeout,
      effort: input.opts.effort,
      structured: true,
    });
    const parsed = parseStructuredJson(raw, input.opts.effort);
    return CritiqueOutputSchema.parse(parsed);
  }

  async revise(input: ReviseInput): Promise<ReviseOutput> {
    ReviseInputSchema.parse(input);
    const prompt = buildRevisePrompt(input);
    const { raw } = await this.runWithRetries({
      prompt,
      timeoutMs: input.opts.timeout,
      effort: input.opts.effort,
      structured: true,
    });
    const parsed = parseStructuredJson(raw, input.opts.effort);
    return ReviseOutputSchema.parse(parsed);
  }

  // ---------- shared spawn + retry ----------

  /**
   * Run one work-call via the CLI. Enforces:
   * - capped timeout retry (base → +50% → base → terminal)
   * - ONE schema-violation repair retry per timeout-attempt
   * - model fallback chain on "model not available" failure
   * - account-default tier (#54): after all explicit pins fail with
   *   model_unavailable, one final attempt with --model omitted
   * - non-interactive flags
   * - minimal env
   *
   * Returns `{ raw, accountDefault }` where raw is the stdout string
   * for the caller to JSON-parse and accountDefault is true when the
   * account-default tier (no explicit --model flag) was used (#54).
   */
  private async runWithRetries(args: {
    prompt: string;
    timeoutMs: number;
    effort: EffortLevel;
    structured: boolean;
  }): Promise<{ raw: string; accountDefault: boolean }> {
    const resolvedBinary =
      resolveBinaryPath(this.host, this.binary) ?? this.binary;

    // Runtime fallback chain: defaultModel first, then any other models
    // not equal to the default (preserving list order, de-duped).
    // When accountDefaultFallback is true, append the sentinel so
    // runSingleAttempt will attempt a --model-less call as a final tier.
    const chain = buildFallbackChain(
      this.modelList,
      this.defaultModel,
      this.accountDefaultFallback,
    );

    // Capped timeout retry (SPEC §7): base -> +50% -> base, then
    // terminal. Timeouts are the only retryable class inside this
    // sweep; `model_unavailable` is consumed by the model-fallback
    // loop inside runSingleAttempt and bubbles up only when every
    // model has been exhausted (including the account-default tier).
    const timeouts = computeAttemptTimeouts(args.timeoutMs);
    let lastFail: CodexAttemptFail | null = null;
    let attemptCount = 0;
    for (const timeout of timeouts) {
      attemptCount += 1;
      const r = await this.runSingleAttempt({
        binary: resolvedBinary,
        prompt: args.prompt,
        timeoutMs: timeout,
        effort: args.effort,
        structured: args.structured,
        models: chain,
      });
      if (r.ok) {
        return { raw: r.value, accountDefault: r.accountDefault === true };
      }
      lastFail = r;
      if (r.reason !== "timeout") {
        break;
      }
    }

    const fail = lastFail;
    if (fail === null) {
      // Only reachable if timeouts is empty, which is impossible.
      throw new CodexAdapterError({
        kind: "terminal",
        reason: "other",
        detail: "no attempts were run",
      });
    }

    const isRetryableClass = fail.reason === "timeout";
    const attempts = isRetryableClass ? attemptCount : 1;
    const base: CodexAdapterErrorPayload = {
      kind: "terminal",
      reason: fail.reason,
      attempts,
    };
    throw new CodexAdapterError(
      fail.detail !== undefined ? { ...base, detail: fail.detail } : base,
    );
  }

  /**
   * One timeout-attempt, which itself is a fallback sweep over the
   * configured model chain. Each model gets up to two spawns — an
   * initial call plus one schema-repair retry. Model-unavailable on a
   * given model rolls to the next; other non-timeout errors bail.
   *
   * The chain may end with ACCOUNT_DEFAULT_SENTINEL, which triggers a
   * final attempt with --model omitted (#54). If that also fails with
   * model_unavailable the terminal detail references the account-default
   * tier so the user can diagnose the failure.
   */
  private async runSingleAttempt(args: {
    binary: string;
    prompt: string;
    timeoutMs: number;
    effort: EffortLevel;
    structured: boolean;
    models: readonly string[];
  }): Promise<CodexAttemptResult<string>> {
    const explicitModels: string[] = [];
    let triedAccountDefault = false;

    for (const model of args.models) {
      if (model === ACCOUNT_DEFAULT_SENTINEL) {
        triedAccountDefault = true;
      } else {
        explicitModels.push(model);
      }

      const r = await this.runModelAttempt({
        binary: args.binary,
        prompt: args.prompt,
        timeoutMs: args.timeoutMs,
        effort: args.effort,
        structured: args.structured,
        model,
      });
      if (r.ok) {
        const accountDefault = model === ACCOUNT_DEFAULT_SENTINEL;
        return { ...r, accountDefault };
      }
      // Only "model_unavailable" rolls forward to the next model.
      // Timeout / schema / other bail now (upper layer may timeout-retry
      // under the capped policy).
      if (r.reason !== "model_unavailable") {
        return r;
      }
    }

    // Every model (and account-default tier if tried) failed.
    // Build an informative detail listing what was attempted (#54).
    const triedList = [...explicitModels];
    if (triedAccountDefault) {
      triedList.push("account-default (no --model flag)");
    }
    const detail =
      triedList.length > 0
        ? `all fallbacks exhausted: ${triedList.join(" → ")}; ` +
          "account is not authorized or no model is available"
        : "no models configured";

    return { ok: false, reason: "model_unavailable", detail };
  }

  private async runModelAttempt(args: {
    binary: string;
    prompt: string;
    timeoutMs: number;
    effort: EffortLevel;
    structured: boolean;
    model: string;
  }): Promise<CodexAttemptResult<string>> {
    const first = await this.spawnOnce({
      binary: args.binary,
      prompt: args.prompt,
      timeoutMs: args.timeoutMs,
      effort: args.effort,
      model: args.model,
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

    // Bug #54: Codex exits 0 and writes the error JSON to stdout when
    // the model is not supported under ChatGPT-account auth. Detect
    // this before the schema-parse / repair path so it is correctly
    // classified as model_unavailable rather than schema_violation.
    const stdoutApiError = classifyStdoutApiError(first.stdout);
    if (stdoutApiError !== null) {
      return stdoutApiError;
    }

    if (!args.structured) {
      return { ok: true, value: first.stdout };
    }

    const parsed = preParseJson(first.stdout);
    if (parsed.ok) {
      return { ok: true, value: first.stdout };
    }

    // Structured violation -> ONE repair retry on this model.
    const repairPrompt = buildRepairPrompt(args.prompt, first.stdout);
    const repair = await this.spawnOnce({
      binary: args.binary,
      prompt: repairPrompt,
      timeoutMs: args.timeoutMs,
      effort: args.effort,
      model: args.model,
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

    // Also check the repair response for API-level errors (#54).
    const repairApiError = classifyStdoutApiError(repair.stdout);
    if (repairApiError !== null) {
      return repairApiError;
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
    model: string;
  }): Promise<SpawnCliResult> {
    const reasoning = EFFORT_TO_REASONING[args.effort];
    // Account-default tier (#54): omit --model so codex picks the
    // account's supported default. All other tiers pin the model.
    const modelFlags: readonly string[] =
      args.model === ACCOUNT_DEFAULT_SENTINEL
        ? []
        : ["--model", args.model];
    const cmd: readonly string[] = [
      args.binary,
      ...CODEX_NON_INTERACTIVE_FLAGS,
      ...modelFlags,
      "-c",
      `model_reasoning_effort=${reasoning}`,
    ];
    const input: SpawnCliInput = {
      cmd,
      stdin: args.prompt,
      env: {},
      timeoutMs: args.timeoutMs,
      extraAllowedEnvKeys: CODEX_AUTH_ENV_KEYS,
      host: this.host,
    };
    return await this.spawnFn(input);
  }
}

// ---------- prompt builders ----------

function buildAskPrompt(input: AskInput): string {
  const ctx = input.context === "" ? "" : `\n\nContext:\n${input.context}\n`;
  return (
    "You are the samospec Reviewer A (Codex). Respond ONLY with a JSON " +
    'object matching the schema { "answer": string, "usage": null, ' +
    `"effort_used": "${input.opts.effort}" }. Do not wrap in code ` +
    "fences." +
    ctx +
    `\n\nQuestion:\n${input.prompt}\n`
  );
}

function buildCritiquePrompt(input: CritiqueInput): string {
  // Persona prefix + taxonomy weighting (SPEC §7 Model roles).
  // Advisory, not a hard filter — reviewer may still surface other
  // categories.
  return (
    `${CODEX_CRITIQUE_PERSONA_PREFIX}\n\n` +
    "You are the samospec reviewer. Return ONLY a JSON object matching " +
    'the review-taxonomy schema: { "findings": Array<{ "category": ' +
    'string, "text": string, "severity": "major"|"minor" }>, "summary":' +
    ' string, "suggested_next_version": string, "usage": null, ' +
    `"effort_used": "${input.opts.effort}" }. Do not wrap in code fences.` +
    `\n\nGuidelines:\n${input.guidelines}\n\nSpec:\n${input.spec}\n`
  );
}

function buildRevisePrompt(input: ReviseInput): string {
  // Reviewer seats rarely call revise(); the method is exposed for
  // adapter-contract parity with the lead seat.
  return (
    "You are the samospec reviewer operating in revise mode. Emit the " +
    "FULL revised SPEC.md text — not a patch. Return ONLY a JSON " +
    'object: { "spec": <full text>, "ready": boolean, "rationale": ' +
    'string, "usage": null, ' +
    `"effort_used": "${input.opts.effort}" }. Do not wrap in code ` +
    `fences.\n\nCurrent spec:\n${input.spec}\n\nReviews (JSON):\n` +
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

// ---------- fallback chain ----------

function buildFallbackChain(
  models: readonly ModelInfo[],
  defaultModel: string,
  appendAccountDefault: boolean,
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Default model first (even if absent from modelList for safety).
  if (!seen.has(defaultModel)) {
    out.push(defaultModel);
    seen.add(defaultModel);
  }
  for (const m of models) {
    if (!seen.has(m.id)) {
      out.push(m.id);
      seen.add(m.id);
    }
  }
  // Account-default tier (#54): after all explicit pins, try once
  // without --model so codex picks the ChatGPT account's default.
  if (appendAccountDefault) {
    out.push(ACCOUNT_DEFAULT_SENTINEL);
  }
  return out;
}

// ---------- response parsing ----------

function parseStructuredJson(
  raw: string,
  requestedEffort: EffortLevel,
): unknown {
  const parsed = preParseJson<Record<string, unknown>>(raw);
  if (!parsed.ok) {
    throw new CodexAdapterError({
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

// Bug #54: Codex exits 0 and emits an API-level error JSON on stdout
// when the requested model is not supported under ChatGPT-account auth.
// The real error shape is:
//   ERROR: {"type":"error","status":400,"error":{"type":
//     "invalid_request_error","message":"The 'X' model is not
//     supported when using Codex with a ChatGPT account."}}
//
// Returns a CodexAttemptFail classified as model_unavailable when the
// stdout matches this pattern, or null when it does not apply.
function classifyStdoutApiError(
  stdout: string,
): CodexAttemptFail | null {
  // Fast path: must contain "invalid_request_error" to be an API error.
  if (!stdout.includes("invalid_request_error")) {
    return null;
  }
  // Extract the JSON payload — may be prefixed by "ERROR: " or similar.
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(jsonStart));
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("error" in parsed)
  ) {
    return null;
  }
  const { error } = parsed as { error: unknown };
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const { type: errType, message } = error as {
    type?: unknown;
    message?: unknown;
  };
  if (errType !== "invalid_request_error") {
    return null;
  }
  const msg = typeof message === "string" ? message : "";
  // Model-unsupported on ChatGPT account → model_unavailable (triggers
  // the fallback chain).
  const lowerMsg = msg.toLowerCase();
  const isModelUnsupported =
    lowerMsg.includes("not supported") ||
    lowerMsg.includes("model") ||
    lowerMsg.includes("account");
  const reason: CodexAdapterErrorReason = isModelUnsupported
    ? "model_unavailable"
    : "other";
  return { ok: false, reason, detail: msg };
}

function classifyExit(
  exitCode: number,
  stderr: string,
): CodexAttemptResult<string> {
  // Stderr heuristic classification per SPEC §7 failure classes.
  // "model not available" / "model unavailable" / "model not found" →
  //   model_unavailable (triggers fallback chain in runSingleAttempt).
  // Rate-limit / 5xx / network / timeout → retryable (maps to timeout).
  // Anything else → terminal (auth, quota, refusal).
  const lower = stderr.toLowerCase();
  // Model-unavailable heuristic: stderr mentions "model" AND one of
  // the unavailable phrases. A vendor-name/quote/etc. may appear
  // between the two tokens, so we test them independently on the
  // same line rather than as a fixed substring.
  const mentionsModel = lower.includes("model");
  const unavailablePhrase =
    lower.includes("not available") ||
    lower.includes("unavailable") ||
    lower.includes("not found") ||
    lower.includes("does not exist") ||
    lower.includes("no such model");
  if (mentionsModel && unavailablePhrase) {
    return {
      ok: false,
      reason: "model_unavailable",
      detail: `exit ${String(exitCode)}: ${stderr.trim()}`,
    };
  }
  const retryable =
    lower.includes("rate limit") ||
    lower.includes("rate-limit") ||
    lower.includes("network error") ||
    lower.includes("timeout") ||
    /\b5\d{2}\b/.test(stderr);
  return {
    ok: false,
    reason: retryable ? "timeout" : "other",
    detail: `exit ${String(exitCode)}: ${stderr.trim()}`,
  };
}

// ---------- error type ----------

export type CodexAdapterErrorReason =
  | "timeout"
  | "schema_violation"
  | "model_unavailable"
  | "other"
  | "codex_cli_auth_failed";

export interface CodexAdapterErrorPayload {
  readonly kind: "terminal";
  readonly reason: CodexAdapterErrorReason;
  readonly detail?: string;
  readonly attempts?: number;
}

export class CodexAdapterError extends Error {
  readonly payload: CodexAdapterErrorPayload;
  constructor(payload: CodexAdapterErrorPayload) {
    const detail = payload.detail ?? "";
    super(`Codex adapter ${payload.reason}: ${detail}`);
    this.name = "CodexAdapterError";
    this.payload = payload;
  }
}
