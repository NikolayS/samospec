// Copyright 2026 Nikolay Samokhvalov.

// SPEC §7: minimal-env non-interactive spawn helper.
// - Allowlist-only env: HOME, PATH, TMPDIR + caller-supplied keys
//   (the adapter's own auth env vars: ANTHROPIC_API_KEY,
//   OPENAI_API_KEY, etc.).
// - Non-interactive flag constants documented per vendor CLI.
// - Doctor-facing verifier that a TTY-less spawn works.

// Current CLI flag reality (documented for #4 doctor):
//
// Claude CLI (as of v1.x / 2026):
//   `--print` ..... non-interactive output mode (one-shot).
//   `--dangerously-skip-permissions` ... bypasses the first-run
//       permission prompt that otherwise hangs a TTY-less spawn.
//   Doctor should additionally run `claude --version --print` and
//   confirm exit 0 with no stdin.
//
// Codex CLI (as of current ship):
//   `exec` ......... non-interactive subcommand (the equivalent of
//       `--non-interactive`). Reads prompt from stdin or `--prompt`.
//   The flag set is expressed as a positional + no-TTY run.
//
// When either CLI adds a clean `--non-interactive` flag we update
// these constants and the doctor verifier in a follow-up.

export const CLAUDE_NON_INTERACTIVE_FLAGS: readonly string[] = [
  "--print",
  "--dangerously-skip-permissions",
];

export const CODEX_NON_INTERACTIVE_FLAGS: readonly string[] = ["exec"];

const BASELINE_ALLOWED_ENV_KEYS: readonly string[] = [
  "HOME",
  "PATH",
  "TMPDIR",
  // USER and LOGNAME are required for macOS Keychain OAuth (#50).
  "USER",
  "LOGNAME",
];

export interface BuildMinimalEnvInput {
  readonly host: Readonly<Record<string, string | undefined>>;
  readonly extraAllowedKeys: readonly string[];
}

export function buildMinimalEnv(
  input: BuildMinimalEnvInput,
): Record<string, string> {
  const allowed = new Set<string>([
    ...BASELINE_ALLOWED_ENV_KEYS,
    ...input.extraAllowedKeys,
  ]);
  const out: Record<string, string> = {};
  for (const key of allowed) {
    const v = input.host[key];
    if (typeof v === "string") {
      out[key] = v;
    }
  }
  return out;
}

// ---------- spawnCli ----------

export interface SpawnCliInput {
  readonly cmd: readonly string[];
  readonly stdin: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly extraAllowedEnvKeys?: readonly string[];
  /**
   * Host env to derive baseline keys from. Defaults to process.env.
   * Tests can inject a deterministic map.
   */
  readonly host?: Readonly<Record<string, string | undefined>>;
}

export type SpawnCliResult =
  | {
      readonly ok: true;
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly ok: false;
      readonly reason: "timeout" | "spawn_error";
      readonly detail?: string;
    };

export async function spawnCli(input: SpawnCliInput): Promise<SpawnCliResult> {
  const host =
    input.host ?? (process.env as Record<string, string | undefined>);
  const envExtras = new Set<string>([
    ...(input.extraAllowedEnvKeys ?? []),
    // Any keys the caller put into `input.env` are explicitly allowed;
    // we still want them forwarded.
    ...Object.keys(input.env),
  ]);

  const baseline = buildMinimalEnv({
    host,
    extraAllowedKeys: [...envExtras],
  });
  // Caller-supplied env overrides baseline (typical case: the caller
  // sets FAKE_CLI_FIXTURE explicitly).
  const finalEnv: Record<string, string> = { ...baseline };
  for (const [k, v] of Object.entries(input.env)) {
    if (typeof v === "string") {
      finalEnv[k] = v;
    }
  }

  let proc: Subprocess;
  try {
    proc = Bun.spawn({
      cmd: [...input.cmd],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: finalEnv,
    }) as unknown as Subprocess;
  } catch (err) {
    return {
      ok: false,
      reason: "spawn_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    proc.stdin.write(input.stdin);
    proc.stdin.end();
  } catch {
    // ignore: child may have already exited.
  }

  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
    try {
      proc.kill("SIGKILL");
    } catch {
      // already dead.
    }
  }, input.timeoutMs);

  // Bun's `new Response(stream).text()` blocks even after SIGKILL because
  // the pipe FD doesn't close immediately. We use a manual reader with
  // Promise.race against an abort signal so the stream read unblocks on
  // timeout without waiting for EOF (#81).
  async function readStream(
    stream: ReadableStream<Uint8Array>,
  ): Promise<string> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      if (ac.signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      onAbort = () => reject(new DOMException("aborted", "AbortError"));
      ac.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      for (;;) {
        const { done, value } = await Promise.race([
          reader.read(),
          abortPromise,
        ]);
        if (done) break;
        if (value !== undefined) chunks.push(value);
      }
    } catch {
      void reader.cancel().catch(() => {
        /* ignore */
      });
    } finally {
      if (onAbort !== undefined)
        ac.signal.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
    const totalLength = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(merged);
  }

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited.catch(() => -1),
  ]);
  clearTimeout(timer);

  if (timedOut) {
    return { ok: false, reason: "timeout" };
  }

  return {
    ok: true,
    exitCode,
    stdout: stdoutText,
    stderr: stderrText,
  };
}

// Narrow subprocess shape we actually use. Bun's own `Subprocess` type
// varies with the generic stdio config; this matches our piped config.
interface Subprocess {
  readonly stdin: { write(chunk: string): void; end(): void };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(signal: string): void;
}

// ---------- doctor helper ----------

export interface VerifyNonInteractiveSpawnInput {
  readonly cmd: readonly string[];
  readonly timeoutMs: number;
}

export type VerifyNonInteractiveSpawnResult =
  | { readonly ok: true; readonly exitCode: number }
  | {
      readonly ok: false;
      readonly reason: "timeout" | "spawn_error" | "nonzero_exit";
      readonly detail?: string;
    };

export async function verifyNonInteractiveSpawn(
  input: VerifyNonInteractiveSpawnInput,
): Promise<VerifyNonInteractiveSpawnResult> {
  const r = await spawnCli({
    cmd: input.cmd,
    stdin: "",
    env: {},
    timeoutMs: input.timeoutMs,
  });
  if (!r.ok) {
    const base = { ok: false as const, reason: r.reason };
    return r.detail !== undefined ? { ...base, detail: r.detail } : base;
  }
  if (r.exitCode !== 0) {
    return {
      ok: false,
      reason: "nonzero_exit",
      detail: `exit ${String(r.exitCode)}: ${r.stderr}`,
    };
  }
  return { ok: true, exitCode: r.exitCode };
}
