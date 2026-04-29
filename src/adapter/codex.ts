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
// - Effort mapping per SPEC §11: logical max → reasoning_effort xhigh,
//   high → high, medium → medium, low → low, off → minimal. Passed as
//   a `--reasoning_effort <level>` flag on every work call.
// - Pinned default model: `gpt-5.4`. Fallback chain on
//   model-unavailable failure: `gpt-5.4 → gpt-5.3-codex →
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
  { id: "gpt-5.4", family: "codex" },
  { id: "gpt-5.3-codex", family: "codex" },
];

const DEFAULT_MODEL_ID = "gpt-5.4";

// Sentinel value appended to the runtime fallback chain to represent
// the account-default tier: codex is invoked with --model omitted so
// it falls back to whatever the ChatGPT account supports. Only reached
// when every explicit pin has raised model_unavailable (#54).
const ACCOUNT_DEFAULT_SENTINEL = "__account_default__" as const;

// SPEC §11 effort-level table (Codex / OpenAI-family column).
// `max` maps to `xhigh` — the highest reasoning level gpt-5.4 supports.
const EFFORT_TO_REASONING: Readonly<Record<EffortLevel, string>> = {
  max: "xhigh",
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
   * Models override. Defaults to pinned `gpt-5.4` +
   * `gpt-5.3-codex` fallback. Order matters: the first entry is the
   * preferred model; subsequent entries are the fallback chain.
   */
  readonly models?: readonly ModelInfo[];
  /**
   * Default model id. Used as the first entry of the runtime fallback
   * chain. Default `gpt-5.4`.
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
    // Bug #54 + #88-1 + #88-followup: Codex may write an API-level error
    // JSON to EITHER stdout (exit 0 path) or stderr (exit 1 path — real
    // codex CLI v0.120.0 shape under ChatGPT-auth rejection). Check both
    // streams BEFORE classifyExit so the correct model_unavailable
    // classification is returned regardless of exit code, allowing the
    // fallback chain to trigger.
    const apiError =
      classifyApiErrorInText(first.stdout) ??
      classifyApiErrorInText(first.stderr);
    if (apiError !== null) {
      return apiError;
    }

    if (first.exitCode !== 0) {
      return classifyExit(first.exitCode, first.stderr);
    }

    if (!args.structured) {
      return { ok: true, value: first.stdout };
    }

    // Bug #88-2: codex exec wraps the JSON response in an agentic
    // header/footer. Extract the JSON block from between the "codex\n"
    // marker and the "tokens used" footer (Option A from the spec).
    const agenticExtracted = extractCodexAgenticJson(first.stdout);
    const rawToparse = agenticExtracted ?? first.stdout;

    const parsed = preParseJson(rawToparse);
    if (parsed.ok) {
      return { ok: true, value: rawToparse };
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
    // Also check the repair response for API-level errors on either
    // stream (#54 / #88-1 / #88-followup).
    const repairApiError =
      classifyApiErrorInText(repair.stdout) ??
      classifyApiErrorInText(repair.stderr);
    if (repairApiError !== null) {
      return repairApiError;
    }

    if (repair.exitCode !== 0) {
      return classifyExit(repair.exitCode, repair.stderr);
    }

    // Apply agentic-wrapper extraction to repair response too (#88-2).
    const repairExtracted = extractCodexAgenticJson(repair.stdout);
    const repairRaw = repairExtracted ?? repair.stdout;

    const parsedRepair = preParseJson(repairRaw);
    if (!parsedRepair.ok) {
      return {
        ok: false,
        reason: "schema_violation",
        detail: parsedRepair.error.message,
      };
    }
    return { ok: true, value: repairRaw };
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
      args.model === ACCOUNT_DEFAULT_SENTINEL ? [] : ["--model", args.model];
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

// Bug #88-2 (Option A) + #88-followup: Extract the JSON block from
// agentic-wrapper stdout emitted by `codex exec`.
//
// `codex exec` emits a multi-section banner:
//   Reading prompt from stdin...
//   OpenAI Codex v0.120.0 (research preview)
//   --------
//   workdir: ...  model: ...  [other metadata]
//   --------
//   user
//   <prompt echo>          ← may itself contain a standalone `codex` line!
//
//   codex                  ← REAL response marker (after user-echo block)
//   <JSON>                 ← starts here
//
//   tokens used            ← ends before this line (if present)
//   2561
//
//   <JSON repeated>
//
// The response marker is a `codex` line followed by text starting with
// `{` (the JSON object). A rogue `codex` mid-prompt-echo does NOT satisfy
// this — it's followed by further prose. So we scan for the `codex`
// line whose next non-blank line begins with `{`, which is the
// structural signature of the real response.
//
// Returns the extracted JSON text, or null when the marker is absent
// (plain output — callers fall back to the raw string).
function extractCodexAgenticJson(raw: string): string | null {
  const lines = raw.split("\n");

  // Locate the response marker: a `codex` line where the next
  // non-blank line begins with `{`. This correctly disambiguates a
  // rogue `codex` token inside the user prompt (which is followed by
  // narrative prose, not a JSON object).
  let codexLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "codex") continue;
    // Peek ahead for the next non-blank line.
    let nextIdx = i + 1;
    while (nextIdx < lines.length && (lines[nextIdx] ?? "").trim() === "") {
      nextIdx++;
    }
    if (nextIdx >= lines.length) continue;
    const firstNonBlank = (lines[nextIdx] ?? "").trimStart();
    if (firstNonBlank.startsWith("{")) {
      codexLineIdx = i;
      break;
    }
  }
  if (codexLineIdx === -1) {
    return null;
  }

  // Collect lines from codexLineIdx+1 until "tokens used" or EOF.
  const jsonLines: string[] = [];
  for (let i = codexLineIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "tokens used") {
      break;
    }
    jsonLines.push(line);
  }

  // Trim trailing blank lines so JSON.parse sees a clean object.
  while (
    jsonLines.length > 0 &&
    (jsonLines[jsonLines.length - 1] ?? "").trim() === ""
  ) {
    jsonLines.pop();
  }

  const extracted = jsonLines.join("\n");
  return extracted.length > 0 ? extracted : null;
}

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

// Bug #54 + #88-followup: Codex emits an API-level error JSON under
// ChatGPT-account auth. The stream carrying the payload depends on the
// exit path:
//   - exit 0 + stdout (original #54 shape: "ERROR: {...}")
//   - exit 1 + stderr (real CLI v0.120.0 shape: banner + "ERROR: {...}")
// The error shape is:
//   ERROR: {"type":"error","status":400,"error":{"type":
//     "invalid_request_error","message":"The 'X' model is not
//     supported when using Codex with a ChatGPT account."}}
//
// Accepts ANY captured text stream and scans for the error signature.
// Extracts the first balanced JSON object starting at the first `{` and
// classifies as model_unavailable when the error type matches. Returns
// null when the text does not carry an API error JSON.
function classifyApiErrorInText(text: string): CodexAttemptFail | null {
  // Fast path: must contain "invalid_request_error" to be an API error.
  if (!text.includes("invalid_request_error")) {
    return null;
  }
  // Extract the first balanced JSON object starting from the first `{`.
  // Stderr may have banner lines + trailing blank lines that confuse a
  // naive `JSON.parse(text.slice(jsonStart))` call, so we walk the
  // string counting braces with string-literal awareness.
  const jsonStart = text.indexOf("{");
  if (jsonStart === -1) {
    return null;
  }
  const jsonBlob = extractFirstBalancedJson(text, jsonStart);
  if (jsonBlob === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonBlob);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) {
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

// Walk `text` starting at `start` (must point at `{`) and return the
// substring that spans the first balanced JSON object (counting `{` and
// `}` with string-literal + escape awareness). Returns null if no
// balanced close is found.
function extractFirstBalancedJson(text: string, start: number): string | null {
  if (text[start] !== "{") {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function classifyExit(
  exitCode: number,
  stderr: string,
): CodexAttemptResult<string> {
  // Stderr heuristic classification per SPEC §7 failure classes.
  // "model not available" / "model unavailable" / "model not found" /
  // "model not supported" (ChatGPT-auth rejection, #88-followup) →
  //   model_unavailable (triggers fallback chain in runSingleAttempt).
  // Rate-limit / 5xx / network / timeout → retryable (maps to timeout).
  // Anything else → terminal (auth, quota, refusal).
  const lower = stderr.toLowerCase();
  // Model-unavailable heuristic: stderr mentions "model" AND one of
  // the unavailable phrases. A vendor-name/quote/etc. may appear
  // between the two tokens, so we test them independently on the
  // same line rather than as a fixed substring. Matching is
  // case-insensitive via the lowercased stderr.
  const mentionsModel = lower.includes("model");
  const unavailablePhrase =
    lower.includes("not available") ||
    lower.includes("unavailable") ||
    lower.includes("not found") ||
    lower.includes("not supported") ||
    lower.includes("does not exist") ||
    lower.includes("no such model");
  if (mentionsModel && unavailablePhrase) {
    return {
      ok: false,
      reason: "model_unavailable",
      detail: `exit ${String(exitCode)}: ${stderr.trim()}`,
    };
  }
  // Bug #148: the previous `\b5\d{2}\b` regex matched ANY three-digit
  // number 500-599 — including token counts ("tokens used\n535")
  // and 3-digit substrings of session UUIDs. That false-positived
  // auth/exit failures into "timeout" (retryable), which then chewed
  // through the capped-retry budget before terminating with a
  // misleading "Codex adapter timeout" message. The replacement
  // requires the 5xx digits to be tagged with `HTTP` or `status`,
  // which is how upstream actually surfaces 5xx.
  const retryable =
    lower.includes("rate limit") ||
    lower.includes("rate-limit") ||
    lower.includes("network error") ||
    lower.includes("timeout") ||
    /\bhttp[\s/]?5\d{2}\b/i.test(stderr) ||
    /\bstatus[:\s]+5\d{2}\b/i.test(stderr);
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
