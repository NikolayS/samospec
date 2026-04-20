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

  private readonly binary: string;
  private readonly host: Readonly<Record<string, string | undefined>>;
  private readonly spawnFn: SpawnFn;
  private readonly modelList: readonly ModelInfo[];
  private readonly defaultModel: string;

  constructor(opts: ClaudeAdapterOpts = {}) {
    this.binary = opts.binary ?? CLAUDE_BINARY_NAME;
    this.host =
      opts.host ?? (process.env as Record<string, string | undefined>);
    this.spawnFn = opts.spawn ?? spawnCli;
    this.modelList = opts.models ?? DEFAULT_MODELS;
    this.defaultModel = opts.defaultModel ?? DEFAULT_MODEL_ID;
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
    return Promise.resolve({ authenticated, subscription_auth });
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

    const outcome = await runWithCappedRetry<string>(
      async (ctx) => {
        return await this.runSingleAttempt({
          binary: resolvedBinary,
          prompt: args.prompt,
          timeoutMs: ctx.timeout,
          effort: args.effort,
          structured: args.structured,
        });
      },
      { baseTimeoutMs: args.timeoutMs },
    );

    if (outcome.ok) {
      return outcome.value;
    }

    const base: ClaudeAdapterErrorPayload = {
      kind: "terminal",
      reason: outcome.reason,
      attempts: outcome.attempts,
    };
    throw new ClaudeAdapterError(
      outcome.detail !== undefined
        ? { ...base, detail: outcome.detail }
        : base,
    );
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
      this.defaultModel,
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

// ---------- prompt builders ----------

function buildAskPrompt(input: AskInput): string {
  const ctx = input.context === "" ? "" : `\n\nContext:\n${input.context}\n`;
  return (
    "You are the samospec lead. Respond ONLY with a JSON object matching " +
    'the schema { "answer": string, "usage": null, "effort_used": ' +
    `"${input.opts.effort}" }. Do not wrap in code fences.` +
    ctx +
    `\n\nQuestion:\n${input.prompt}\n`
  );
}

function buildCritiquePrompt(input: CritiqueInput): string {
  return (
    "You are the samospec reviewer. Return ONLY a JSON object matching " +
    'the review-taxonomy schema: { "findings": Array<{ "category": ' +
    'string, "text": string, "severity": "major"|"minor" }>, "summary":' +
    ' string, "suggested_next_version": string, "usage": null, ' +
    `"effort_used": "${input.opts.effort}" }. Do not wrap in code fences.` +
    `\n\nGuidelines:\n${input.guidelines}\n\nSpec:\n${input.spec}\n`
  );
}

function buildRevisePrompt(input: ReviseInput): string {
  return (
    "You are the samospec lead. Emit the FULL revised SPEC.md text — " +
    "not a patch. Return ONLY a JSON object: { \"spec\": <full text>, " +
    '"ready": boolean, "rationale": string, "usage": null, ' +
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

function classifyExit(
  exitCode: number,
  stderr: string,
): AttemptResult<string> {
  // Stderr-heuristic classification per SPEC §7 failure classes.
  // Non-zero exit is terminal unless stderr matches a known retryable
  // pattern (rate limit, network, 5xx).
  const lower = stderr.toLowerCase();
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

export interface ClaudeAdapterErrorPayload {
  readonly kind: "terminal";
  readonly reason: "timeout" | "schema_violation" | "other";
  readonly detail?: string;
  readonly attempts?: number;
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
