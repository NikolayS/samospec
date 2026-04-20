// Copyright 2026 Nikolay Samokhvalov.

// RED tests for #48: Claude adapter work calls proceed when
// subscription_auth:true (OAuth mode). The old #47 fail-fast gate
// must be removed. When auth_status().subscription_auth:true, ask(),
// critique(), and revise() must attempt to spawn the CLI — they must
// NOT throw subscription_auth_unsupported before spawning.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClaudeAdapter,
  ClaudeAdapterError,
} from "../../src/adapter/claude.ts";
import type { SpawnCliInput, SpawnCliResult } from "../../src/adapter/spawn.ts";

const TMP: string[] = [];

afterAll(() => {
  for (const d of TMP) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeFakeBinary(name: string, script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "samospec-oauth-proceeds-"));
  TMP.push(dir);
  const binary = join(dir, name);
  writeFileSync(binary, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(binary, 0o755);
  return dir;
}

const OPTS = { effort: "max" as const, timeout: 30_000 };
const SAMPLE_ASK = { prompt: "ping", context: "", opts: OPTS };
const SAMPLE_CRITIQUE = {
  spec: "# S\n\ntext",
  guidelines: "be thorough",
  opts: OPTS,
};
const SAMPLE_REVISE = {
  spec: "# S\n\ntext",
  reviews: [],
  decisions_history: [],
  opts: OPTS,
};

/**
 * Create an adapter in OAuth mode (no ANTHROPIC_API_KEY) with a
 * counting spawn that records calls. The spawn always returns exit 1
 * so work calls fail — but at least spawn was reached.
 */
function makeOAuthAdapterWithCountingSpawn(): {
  adapter: ClaudeAdapter;
  spawnCalls: number[];
} {
  const dir = makeFakeBinary("claude", 'echo "2.1.114"');
  const spawnCalls: number[] = [];
  const countingSpawn = (_input: SpawnCliInput): Promise<SpawnCliResult> => {
    spawnCalls.push(1);
    // Return a non-zero exit — work call fails, but spawn was reached.
    return Promise.resolve({
      ok: true,
      exitCode: 1,
      stdout: "",
      stderr: "simulated error for test",
    });
  };
  // No ANTHROPIC_API_KEY → OAuth / subscription_auth:true
  const adapter = new ClaudeAdapter({
    host: { PATH: dir, HOME: "/tmp" },
    spawn: countingSpawn,
  });
  return { adapter, spawnCalls };
}

describe("ClaudeAdapter — OAuth mode proceeds to spawn", () => {
  test("auth_status() reports subscription_auth:true with no API key", async () => {
    const { adapter } = makeOAuthAdapterWithCountingSpawn();
    const status = await adapter.auth_status();
    expect(status.authenticated).toBe(true);
    expect(status.subscription_auth).toBe(true);
  });

  test("ask() reaches spawn (does NOT throw subscription_auth_unsupported)", async () => {
    const { adapter, spawnCalls } = makeOAuthAdapterWithCountingSpawn();
    let thrown: unknown;
    try {
      await adapter.ask(SAMPLE_ASK);
    } catch (e) {
      thrown = e;
    }
    // Spawn must have been called
    expect(spawnCalls.length).toBeGreaterThan(0);
    // Must NOT be subscription_auth_unsupported
    if (thrown instanceof ClaudeAdapterError) {
      expect(thrown.payload.reason).not.toBe("subscription_auth_unsupported");
    }
  });

  test("critique() reaches spawn (does NOT throw subscription_auth_unsupported)", async () => {
    const { adapter, spawnCalls } = makeOAuthAdapterWithCountingSpawn();
    let thrown: unknown;
    try {
      await adapter.critique(SAMPLE_CRITIQUE);
    } catch (e) {
      thrown = e;
    }
    expect(spawnCalls.length).toBeGreaterThan(0);
    if (thrown instanceof ClaudeAdapterError) {
      expect(thrown.payload.reason).not.toBe("subscription_auth_unsupported");
    }
  });

  test("revise() reaches spawn (does NOT throw subscription_auth_unsupported)", async () => {
    const { adapter, spawnCalls } = makeOAuthAdapterWithCountingSpawn();
    let thrown: unknown;
    try {
      await adapter.revise(SAMPLE_REVISE);
    } catch (e) {
      thrown = e;
    }
    expect(spawnCalls.length).toBeGreaterThan(0);
    if (thrown instanceof ClaudeAdapterError) {
      expect(thrown.payload.reason).not.toBe("subscription_auth_unsupported");
    }
  });

  test("API key present: still proceeds to spawn (unchanged behavior)", async () => {
    const dir = makeFakeBinary("claude", 'echo "2.1.114"');
    const spawnCalls: number[] = [];
    const countingSpawn = (_input: SpawnCliInput): Promise<SpawnCliResult> => {
      spawnCalls.push(1);
      return Promise.resolve({
        ok: true,
        exitCode: 1,
        stdout: "",
        stderr: "some error",
      });
    };
    const adapter = new ClaudeAdapter({
      host: { PATH: dir, HOME: "/tmp", ANTHROPIC_API_KEY: "sk-ant-fake" },
      spawn: countingSpawn,
    });
    try {
      await adapter.ask(SAMPLE_ASK);
    } catch {
      // Expected to fail, not subscription_auth_unsupported
    }
    expect(spawnCalls.length).toBeGreaterThan(0);
  });
});
