// Copyright 2026 Nikolay Samokhvalov.

// Issue #127: when Claude CLI exits 0 but prints "Invalid API key"
// to stdout, the adapter must surface an actionable error that tells
// the user to `unset ANTHROPIC_API_KEY` or verify the key.
//
// The pattern: `claude -p "…"` returns exit 0 with stdout:
//   "Invalid API key · Fix external API key\n"
// This is NOT valid JSON, so without the fix the adapter falls through
// to schema_violation, producing a blank/unhelpful error.
//
// After the fix the thrown ClaudeAdapterError must:
//   - have reason "claude_cli_auth_failed"
//   - have detail containing "unset ANTHROPIC_API_KEY"
//   - have detail containing "https://console.anthropic.com/settings/keys"
//
// Issue #138: the same detection must also apply on the repair-retry
// path (second spawn). If auth becomes invalid between the first spawn
// and the repair call, the error should still surface as
// "claude_cli_auth_failed", not "schema_violation".

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAdapter, ClaudeAdapterError } from "../../src/adapter/claude.ts";
import type { SpawnCliInput, SpawnCliResult } from "../../src/adapter/spawn.ts";

function makeFakeBinaryDir(
  name: string,
  script: string,
): { dir: string; binary: string } {
  const dir = mkdtempSync(join(tmpdir(), "samospec-inv-key-"));
  const binary = join(dir, name);
  writeFileSync(binary, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(binary, 0o755);
  return { dir, binary };
}

function makeInstalledHost(): Record<string, string | undefined> {
  const { dir } = makeFakeBinaryDir("claude", 'echo "2.1.118"');
  return {
    PATH: dir,
    HOME: "/tmp",
    ANTHROPIC_API_KEY: "sk-ant-api03-OBVIOUSLY_FAKE",
  };
}

/**
 * A spawn spy that returns exit 0 with the exact stdout the Claude CLI
 * emits when ANTHROPIC_API_KEY is invalid.
 */
function makeInvalidKeySpawn(
  stdout: string,
): (input: SpawnCliInput) => Promise<SpawnCliResult> {
  return (_input: SpawnCliInput): Promise<SpawnCliResult> => {
    return Promise.resolve({
      ok: true,
      exitCode: 0,
      stdout,
      stderr: "",
    });
  };
}

describe("ClaudeAdapter — Invalid API key stdout detection (issue #127)", () => {
  test(
    "ask() with 'Invalid API key' stdout → " +
      "ClaudeAdapterError reason=claude_cli_auth_failed",
    async () => {
      const host = makeInstalledHost();
      const adapter = new ClaudeAdapter({
        host,
        spawn: makeInvalidKeySpawn("Invalid API key · Fix external API key\n"),
      });

      let err: unknown;
      try {
        await adapter.ask({
          prompt: "ping",
          context: "",
          opts: { effort: "max", timeout: 5_000 },
        });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ClaudeAdapterError);
      if (err instanceof ClaudeAdapterError) {
        expect(err.payload.reason).toBe("claude_cli_auth_failed");
        expect(err.payload.kind).toBe("terminal");
      }
    },
  );

  test("error detail contains 'unset ANTHROPIC_API_KEY' guidance", async () => {
    const host = makeInstalledHost();
    const adapter = new ClaudeAdapter({
      host,
      spawn: makeInvalidKeySpawn("Invalid API key · Fix external API key\n"),
    });

    let err: unknown;
    try {
      await adapter.ask({
        prompt: "ping",
        context: "",
        opts: { effort: "max", timeout: 5_000 },
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(ClaudeAdapterError);
    if (err instanceof ClaudeAdapterError) {
      const detail = err.payload.detail ?? "";
      expect(detail.toLowerCase()).toContain("unset anthropic_api_key");
      expect(detail).toContain("https://console.anthropic.com/settings/keys");
    }
  });

  test(
    "detection is case-insensitive: 'invalid api key' (lowercase) " +
      "also triggers the auth error",
    async () => {
      const host = makeInstalledHost();
      const adapter = new ClaudeAdapter({
        host,
        spawn: makeInvalidKeySpawn("invalid api key · fix external api key\n"),
      });

      let err: unknown;
      try {
        await adapter.ask({
          prompt: "ping",
          context: "",
          opts: { effort: "max", timeout: 5_000 },
        });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ClaudeAdapterError);
      if (err instanceof ClaudeAdapterError) {
        expect(err.payload.reason).toBe("claude_cli_auth_failed");
      }
    },
  );

  test(
    "unrelated stdout ('some other error') still falls through " +
      "to schema_violation — no false positive",
    async () => {
      const host = makeInstalledHost();
      const adapter = new ClaudeAdapter({
        host,
        spawn: makeInvalidKeySpawn("some other error output\n"),
      });

      let err: unknown;
      try {
        await adapter.ask({
          prompt: "ping",
          context: "",
          opts: { effort: "max", timeout: 5_000 },
        });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ClaudeAdapterError);
      if (err instanceof ClaudeAdapterError) {
        // Must NOT be misclassified as an auth failure.
        expect(err.payload.reason).not.toBe("claude_cli_auth_failed");
      }
    },
  );
});

// ---------- Issue #138: repair-retry path ----------

/**
 * Spawn spy that returns invalid JSON on the first call (triggers
 * repair) and "Invalid API key" stdout on the second call (simulates
 * auth failure during repair).
 */
function makeInvalidKeyOnRepairSpawn(): (
  input: SpawnCliInput,
) => Promise<SpawnCliResult> {
  let callCount = 0;
  return (_input: SpawnCliInput): Promise<SpawnCliResult> => {
    callCount += 1;
    if (callCount === 1) {
      // First spawn: return malformed JSON to trigger repair retry.
      return Promise.resolve({
        ok: true,
        exitCode: 0,
        stdout: "not valid json {{{",
        stderr: "",
      });
    }
    // Repair spawn: auth failure.
    return Promise.resolve({
      ok: true,
      exitCode: 0,
      stdout: "Invalid API key · Fix external API key\n",
      stderr: "",
    });
  };
}

describe("ClaudeAdapter — Invalid API key on repair-retry path (issue #138)", () => {
  test(
    "repair spawn with 'Invalid API key' stdout → " +
      "reason=claude_cli_auth_failed, not schema_violation",
    async () => {
      const host = makeInstalledHost();
      const adapter = new ClaudeAdapter({
        host,
        spawn: makeInvalidKeyOnRepairSpawn(),
      });

      let err: unknown;
      try {
        await adapter.ask({
          prompt: "ping",
          context: "",
          opts: { effort: "max", timeout: 5_000 },
        });
      } catch (e) {
        err = e;
      }

      expect(err).toBeInstanceOf(ClaudeAdapterError);
      if (err instanceof ClaudeAdapterError) {
        expect(err.payload.reason).toBe("claude_cli_auth_failed");
        expect(err.payload.reason).not.toBe("schema_violation");
      }
    },
  );

  test(
    "spec-content JSON containing 'Invalid API key' as body text " +
      "does not false-positive on the repair path",
    async () => {
      // Build a valid JSON payload whose body happens to contain the
      // auth-error phrase — this guards the most plausible false-positive.
      // ask() expects AskOutputSchema shape.
      const bodyWithPhrase = JSON.stringify({
        ready: false,
        rationale: "Invalid API key is a common auth error message.",
        spec_md: "# Test\n\nInvalid API key warning section.\n",
      });
      const host = makeInstalledHost();
      let callCount = 0;
      const safeSpawn = (_input: SpawnCliInput): Promise<SpawnCliResult> => {
        callCount += 1;
        if (callCount === 1) {
          // First spawn: invalid JSON to force repair.
          return Promise.resolve({
            ok: true,
            exitCode: 0,
            stdout: "not valid json {{{",
            stderr: "",
          });
        }
        // Repair spawn: valid JSON whose body contains the phrase.
        return Promise.resolve({
          ok: true,
          exitCode: 0,
          stdout: bodyWithPhrase,
          stderr: "",
        });
      };
      const adapter = new ClaudeAdapter({ host, spawn: safeSpawn });

      let err: unknown;
      try {
        await adapter.ask({
          prompt: "ping",
          context: "",
          opts: { effort: "max", timeout: 5_000 },
        });
      } catch (e) {
        err = e;
      }

      // Should throw (schema_violation or similar), but NOT auth failure.
      if (err instanceof ClaudeAdapterError) {
        expect(err.payload.reason).not.toBe("claude_cli_auth_failed");
      }
    },
  );
});
