// Copyright 2026 Nikolay Samokhvalov.

// RED tests for Issue #54: Codex unusable under ChatGPT-account auth.
//
// Three confirmed bugs:
// 1. Misclassification: exit-0 stdout with invalid_request_error JSON
//    is treated as a schema_violation, not model_unavailable.
// 2. No account-default tier: after both explicit pins fail with
//    model_unavailable, the adapter should attempt one final call
//    with --model omitted (letting codex pick the account default)
//    rather than going terminal immediately.
// 3. No visibility: the account-default fallback is not recorded in
//    state, so `samospec status` cannot surface it.
//
// Fixture: fake-CLI emitting the real ChatGPT-auth error shape on
// stdout with exit 0 (confirmed codex behavior).

import {
  afterAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CodexAdapter,
  CodexAdapterError,
} from "../../src/adapter/codex.ts";
import type { AskInput, EffortLevel } from "../../src/adapter/types.ts";
import type {
  SpawnCliInput,
  SpawnCliResult,
} from "../../src/adapter/spawn.ts";
import { spawnCli } from "../../src/adapter/spawn.ts";

const BUN_DIR = dirname(process.execPath);
const FAKE_CLI = new URL(
  "../fixtures/fake-cli.ts",
  import.meta.url,
).pathname;

function codexFixture(name: string): string {
  return new URL(
    `../fixtures/codex-fixtures/${name}`,
    import.meta.url,
  ).pathname;
}

const TMP: string[] = [];

function makeFakeBinaryDir(
  name: string,
  script: string,
): { dir: string; binary: string } {
  const dir = mkdtempSync(join(tmpdir(), "samospec-codex54-bin-"));
  TMP.push(dir);
  const binary = join(dir, name);
  writeFileSync(binary, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(binary, 0o755);
  return { dir, binary };
}

afterAll(() => {
  for (const d of TMP) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ---------- spawn-spy helpers ----------

interface SpawnSpyCall {
  readonly cmd: readonly string[];
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly env: Record<string, string | undefined>;
  readonly extraAllowedEnvKeys: readonly string[];
}

interface SpawnSpy {
  readonly spawn: (input: SpawnCliInput) => Promise<SpawnCliResult>;
  readonly calls: SpawnSpyCall[];
}

function makeSpy(
  responses: SpawnCliResult | readonly SpawnCliResult[],
): SpawnSpy {
  const calls: SpawnSpyCall[] = [];
  const spawn = (input: SpawnCliInput): Promise<SpawnCliResult> => {
    calls.push({
      cmd: [...input.cmd],
      stdin: input.stdin,
      timeoutMs: input.timeoutMs,
      env: { ...input.env },
      extraAllowedEnvKeys: [...(input.extraAllowedEnvKeys ?? [])],
    });
    const idx = calls.length - 1;
    const result = Array.isArray(responses)
      ? (responses[idx] ?? responses[responses.length - 1]!)
      : (responses as SpawnCliResult);
    return Promise.resolve(result);
  };
  return { spawn, calls };
}

function makeFakeCliSpy(opts: {
  fixture: string;
  stateFile?: string;
}): SpawnSpy {
  const calls: SpawnSpyCall[] = [];
  const spawn = async (
    input: SpawnCliInput,
  ): Promise<SpawnCliResult> => {
    calls.push({
      cmd: [...input.cmd],
      stdin: input.stdin,
      timeoutMs: input.timeoutMs,
      env: { ...input.env },
      extraAllowedEnvKeys: [...(input.extraAllowedEnvKeys ?? [])],
    });
    const env: Record<string, string | undefined> = {
      ...input.env,
      FAKE_CLI_FIXTURE: opts.fixture,
    };
    if (opts.stateFile !== undefined) {
      env["FAKE_CLI_STATE_FILE"] = opts.stateFile;
    }
    const hostSnapshot: Record<string, string | undefined> = {
      ...(input.host ?? {}),
    };
    const hostPath = hostSnapshot["PATH"] ?? "";
    hostSnapshot["PATH"] =
      hostPath === "" ? BUN_DIR : `${BUN_DIR}:${hostPath}`;

    const rewritten: SpawnCliInput = {
      cmd: ["bun", "run", FAKE_CLI],
      stdin: input.stdin,
      env,
      timeoutMs: input.timeoutMs,
      extraAllowedEnvKeys: [
        ...(input.extraAllowedEnvKeys ?? []),
        "FAKE_CLI_FIXTURE",
        "FAKE_CLI_STATE_FILE",
      ],
      host: hostSnapshot,
    };
    return await spawnCli(rewritten);
  };
  return { spawn, calls };
}

// ---------- host / adapter helpers ----------

const OPTS_HIGH_120: { effort: EffortLevel; timeout: number } = {
  effort: "high",
  timeout: 120_000,
};

function makeInstalledHost(): {
  host: Record<string, string | undefined>;
  binaryPath: string;
} {
  const { dir, binary } = makeFakeBinaryDir("codex", 'echo "0.42.0"');
  return {
    host: { PATH: dir, HOME: "/tmp" },
    binaryPath: binary,
  };
}

function sampleAsk(): AskInput {
  return { prompt: "ping", context: "", opts: OPTS_HIGH_120 };
}

// ---------- Bug 1: misclassification (exit-0 + stdout error JSON) ----------

describe(
  "Bug #54-1: ChatGPT-auth error on stdout exit-0 → model_unavailable",
  () => {
    test(
      "exit-0 with invalid_request_error stdout classifies as " +
        "model_unavailable, not schema_violation",
      async () => {
        // The real Codex CLI emits the error JSON on stdout with exit 0
        // when the model is not supported under ChatGPT-account auth.
        // The current adapter misses this and falls through to the
        // schema-repair path, ultimately classifying it as schema_violation.
        const spy = makeSpy({
          ok: true,
          exitCode: 0,
          stdout:
            "ERROR: " +
            JSON.stringify({
              type: "error",
              status: 400,
              error: {
                type: "invalid_request_error",
                message:
                  "The 'gpt-5.1-codex-max' model is not supported " +
                  "when using Codex with a ChatGPT account.",
              },
            }) +
            "\n",
          stderr: "",
        });
        const { host } = makeInstalledHost();
        const adapter = new CodexAdapter({
          host,
          spawn: spy.spawn,
          // Single-model list so we see the classification in isolation.
          models: [{ id: "gpt-5.1-codex-max", family: "codex" }],
        });

        let err: unknown;
        try {
          await adapter.ask(sampleAsk());
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(CodexAdapterError);
        if (err instanceof CodexAdapterError) {
          expect(err.payload.reason).toBe("model_unavailable");
          expect(err.payload.kind).toBe("terminal");
          // Must NOT be schema_violation (the pre-fix regression).
          expect(err.payload.reason).not.toBe("schema_violation");
        }
      },
    );

    test(
      "fake-CLI fixture: real ChatGPT-auth error shape classifies as " +
        "model_unavailable",
      async () => {
        const spy = makeFakeCliSpy({
          fixture: codexFixture("chatgpt-auth-error-max.json"),
        });
        const { host } = makeInstalledHost();
        const adapter = new CodexAdapter({
          host,
          spawn: spy.spawn,
          models: [{ id: "gpt-5.1-codex-max", family: "codex" }],
        });

        let err: unknown;
        try {
          await adapter.ask(sampleAsk());
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(CodexAdapterError);
        if (err instanceof CodexAdapterError) {
          expect(err.payload.reason).toBe("model_unavailable");
        }
        // Only one spawn — no repair retry on model_unavailable.
        expect(spy.calls.length).toBe(1);
      },
    );
  },
);

// ---------- Bug 2: no account-default fallback tier ----------

describe("Bug #54-2: account-default fallback after both explicit pins fail", () => {
  test(
    "both explicit pins → model_unavailable, third call has NO --model flag",
    async () => {
      const stateDir = mkdtempSync(
        join(tmpdir(), "samospec-codex54-state-"),
      );
      TMP.push(stateDir);
      const stateJson = join(stateDir, "state.json");
      writeFileSync(stateJson, JSON.stringify({ call: 0 }));

      const spy = makeFakeCliSpy({
        fixture: codexFixture(
          "chatgpt-auth-both-fail-then-default.json",
        ),
        stateFile: stateJson,
      });
      const { host } = makeInstalledHost();
      const adapter = new CodexAdapter({ host, spawn: spy.spawn });

      const out = await adapter.ask(sampleAsk());

      // The adapter must succeed using the account-default tier.
      expect(out.answer).toBe("account-default-ok");

      // Three spawns: gpt-5.1-codex-max (fail), gpt-5.1-codex (fail),
      // account-default (no --model flag, success).
      expect(spy.calls.length).toBe(3);

      // Third call must NOT include --model in argv.
      const thirdCmd = spy.calls[2]?.cmd ?? [];
      expect(thirdCmd).not.toContain("--model");
      // First and second calls had explicit --model pins.
      expect(spy.calls[0]?.cmd).toContain("--model");
      expect(spy.calls[1]?.cmd).toContain("--model");
    },
  );

  test(
    "account-default success → adapter records account_default: true" +
      " in result metadata",
    async () => {
      // The adapter must expose whether it fell back to account-default
      // so the resolver can write it to state.json for visibility.
      const spy = makeSpy([
        // gpt-5.1-codex-max: ChatGPT-auth error (exit 0, stdout)
        {
          ok: true,
          exitCode: 0,
          stdout:
            "ERROR: " +
            JSON.stringify({
              type: "error",
              status: 400,
              error: {
                type: "invalid_request_error",
                message:
                  "The 'gpt-5.1-codex-max' model is not supported " +
                  "when using Codex with a ChatGPT account.",
              },
            }) +
            "\n",
          stderr: "",
        },
        // gpt-5.1-codex: ChatGPT-auth error (exit 0, stdout)
        {
          ok: true,
          exitCode: 0,
          stdout:
            "ERROR: " +
            JSON.stringify({
              type: "error",
              status: 400,
              error: {
                type: "invalid_request_error",
                message:
                  "The 'gpt-5.1-codex' model is not supported " +
                  "when using Codex with a ChatGPT account.",
              },
            }) +
            "\n",
          stderr: "",
        },
        // Account-default: success
        {
          ok: true,
          exitCode: 0,
          stdout: '{"answer":"ok","usage":null,"effort_used":"high"}',
          stderr: "",
        },
      ]);
      const { host } = makeInstalledHost();
      const adapter = new CodexAdapter({ host, spawn: spy.spawn });

      const out = await adapter.ask(sampleAsk());
      expect(out.answer).toBe("ok");

      // The adapter must expose account_default resolution so the
      // resolver / state.json layer can surface it.
      expect((out as Record<string, unknown>)["account_default"]).toBe(
        true,
      );
    },
  );
});

// ---------- Bug 3: terminal when account-default also fails ----------

describe(
  "Bug #54-3: terminal with informative message when all tiers fail",
  () => {
    test(
      "all three tiers fail → terminal CodexAdapterError listing " +
        "all attempted tiers",
      async () => {
        // All three responses: ChatGPT-auth error (exit 0, stdout)
        const chatGptError = (model: string): SpawnCliResult => ({
          ok: true,
          exitCode: 0,
          stdout:
            "ERROR: " +
            JSON.stringify({
              type: "error",
              status: 400,
              error: {
                type: "invalid_request_error",
                message: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
              },
            }) +
            "\n",
          stderr: "",
        });

        const spy = makeSpy([
          chatGptError("gpt-5.1-codex-max"),
          chatGptError("gpt-5.1-codex"),
          // Account-default also fails: same error shape, no model name.
          {
            ok: true,
            exitCode: 0,
            stdout:
              "ERROR: " +
              JSON.stringify({
                type: "error",
                status: 400,
                error: {
                  type: "invalid_request_error",
                  message:
                    "Your ChatGPT account is not authorized " +
                    "for Codex API access.",
                },
              }) +
              "\n",
            stderr: "",
          },
        ]);
        const { host } = makeInstalledHost();
        const adapter = new CodexAdapter({ host, spawn: spy.spawn });

        let err: unknown;
        try {
          await adapter.ask(sampleAsk());
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(CodexAdapterError);
        if (err instanceof CodexAdapterError) {
          expect(err.payload.kind).toBe("terminal");
          expect(err.payload.reason).toBe("model_unavailable");
          // The detail must mention that fallbacks were attempted so
          // the user can diagnose the failure.
          const detail = err.payload.detail ?? "";
          expect(detail.toLowerCase()).toContain("account");
        }
        // All three tiers were attempted.
        expect(spy.calls.length).toBe(3);
        // Third call had no --model flag (account-default tier).
        const thirdCmd = spy.calls[2]?.cmd ?? [];
        expect(thirdCmd).not.toContain("--model");
      },
    );

    test(
      "fake-CLI fixture: all-fail path → terminal model_unavailable",
      async () => {
        const spy = makeFakeCliSpy({
          fixture: codexFixture("chatgpt-auth-all-fail.json"),
        });
        const { host } = makeInstalledHost();
        const adapter = new CodexAdapter({ host, spawn: spy.spawn });

        let err: unknown;
        try {
          await adapter.ask(sampleAsk());
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(CodexAdapterError);
        if (err instanceof CodexAdapterError) {
          expect(err.payload.kind).toBe("terminal");
          expect(err.payload.reason).toBe("model_unavailable");
        }
      },
    );
  },
);
