// Copyright 2026 Nikolay Samokhvalov.

// SPEC §7 + §11: the real Codex adapter (Reviewer A seat).
//
// Lifecycle skeleton only. Work calls (ask/critique/revise) and auth
// probing are added in subsequent red-green commits.
//
// Non-interactive flags: `codex exec` subcommand is the installed
// target's headless mode (see src/adapter/spawn.ts CODEX_NON_INTERACTIVE_FLAGS).
// Minimal env: HOME, PATH, TMPDIR, OPENAI_API_KEY (when present).
// Structured output: stdout is captured, passed through the shared
// pre-parser, then zod-validated.
// Pinned default model: gpt-5.1-codex-max. Fallback chain:
// gpt-5.1-codex-max -> gpt-5.1-codex -> terminal (SPEC §11).

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { spawnCli } from "./spawn.ts";
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
   * Models override. Defaults to pinned `gpt-5.1-codex-max` + fallback.
   */
  readonly models?: readonly ModelInfo[];
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

  constructor(opts: CodexAdapterOpts = {}) {
    this.binary = opts.binary ?? CODEX_BINARY_NAME;
    this.host =
      opts.host ?? (process.env as Record<string, string | undefined>);
    this.spawnFn = opts.spawn ?? spawnCli;
    this.modelList = opts.models ?? DEFAULT_MODELS;
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

  // ---------- auth (stub — expanded in later commit) ----------

  auth_status(): Promise<AuthStatus> {
    return Promise.resolve({ authenticated: false });
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

  // ---------- work calls (stubs — expanded in later commit) ----------

  ask(_input: AskInput): Promise<AskOutput> {
    return Promise.reject(new Error("CodexAdapter.ask not yet implemented"));
  }

  critique(_input: CritiqueInput): Promise<CritiqueOutput> {
    return Promise.reject(
      new Error("CodexAdapter.critique not yet implemented"),
    );
  }

  revise(_input: ReviseInput): Promise<ReviseOutput> {
    return Promise.reject(
      new Error("CodexAdapter.revise not yet implemented"),
    );
  }
}
