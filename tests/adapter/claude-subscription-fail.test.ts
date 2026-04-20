// Copyright 2026 Nikolay Samokhvalov.

// RED tests for #45 + #46: Claude adapter work calls fail fast when
// subscription_auth:true and ANTHROPIC_API_KEY is absent.
//
// When auth_status().usable_for_noninteractive === false, any call to
// ask(), critique(), or revise() must throw a ClaudeAdapterError with
// reason "subscription_auth_unsupported" — WITHOUT spawning the CLI.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAdapter, ClaudeAdapterError } from "../../src/adapter/claude.ts";
import type { SpawnCliInput, SpawnCliResult } from "../../src/adapter/spawn.ts";

const TMP: string[] = [];

function makeFakeBinary(name: string, script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "samospec-sub-fail-"));
  TMP.push(dir);
  const binary = join(dir, name);
  writeFileSync(binary, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(binary, 0o755);
  return dir;
}

// A spy spawn that always panics if called — work calls must NOT reach spawn
// when subscription auth without API key is detected.
function makePanicSpawn(): (input: SpawnCliInput) => Promise<SpawnCliResult> {
  return (_input: SpawnCliInput): Promise<SpawnCliResult> => {
    throw new Error(
      "spawn was called but should have been blocked by subscription-auth check",
    );
  };
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

function makeSubscriptionAdapter(): ClaudeAdapter {
  // Binary exists (so auth_status returns authenticated:true,
  // subscription_auth:true) but no ANTHROPIC_API_KEY in host env.
  const dir = makeFakeBinary("claude", 'echo "2.1.114"');
  return new ClaudeAdapter({
    host: { PATH: dir, HOME: "/tmp" },
    spawn: makePanicSpawn(),
  });
}

describe("ClaudeAdapter — subscription_auth_unsupported fail-fast", () => {
  test("ask() throws ClaudeAdapterError with reason subscription_auth_unsupported", async () => {
    const adapter = makeSubscriptionAdapter();
    let thrown: unknown;
    try {
      await adapter.ask(SAMPLE_ASK);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ClaudeAdapterError);
    const err = thrown as ClaudeAdapterError;
    expect(err.payload.reason).toBe("subscription_auth_unsupported");
  });

  test("critique() throws ClaudeAdapterError with reason subscription_auth_unsupported", async () => {
    const adapter = makeSubscriptionAdapter();
    let thrown: unknown;
    try {
      await adapter.critique(SAMPLE_CRITIQUE);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ClaudeAdapterError);
    const err = thrown as ClaudeAdapterError;
    expect(err.payload.reason).toBe("subscription_auth_unsupported");
  });

  test("revise() throws ClaudeAdapterError with reason subscription_auth_unsupported", async () => {
    const adapter = makeSubscriptionAdapter();
    let thrown: unknown;
    try {
      await adapter.revise(SAMPLE_REVISE);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ClaudeAdapterError);
    const err = thrown as ClaudeAdapterError;
    expect(err.payload.reason).toBe("subscription_auth_unsupported");
  });

  test("error message mentions ANTHROPIC_API_KEY", async () => {
    const adapter = makeSubscriptionAdapter();
    let thrown: unknown;
    try {
      await adapter.ask(SAMPLE_ASK);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ClaudeAdapterError);
    const err = thrown as ClaudeAdapterError;
    expect(err.message).toContain("ANTHROPIC_API_KEY");
  });

  test("error message mentions console.anthropic.com", async () => {
    const adapter = makeSubscriptionAdapter();
    let thrown: unknown;
    try {
      await adapter.ask(SAMPLE_ASK);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ClaudeAdapterError);
    const err = thrown as ClaudeAdapterError;
    expect(err.message).toContain("console.anthropic.com");
  });

  test("spawn is never called (fail-fast before spawn)", async () => {
    // The panic spawn would throw if called — if we reach here without
    // it throwing, the work call never called spawn.
    const adapter = makeSubscriptionAdapter();
    // We just need to catch the subscription_auth_unsupported error;
    // if we get a different error (like "spawn was called"), the test fails.
    let thrown: unknown;
    try {
      await adapter.ask(SAMPLE_ASK);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ClaudeAdapterError);
    expect((thrown as ClaudeAdapterError).payload.reason).toBe(
      "subscription_auth_unsupported",
    );
  });

  test("auth_status() still reports authenticated:true with subscription_auth:true", async () => {
    const adapter = makeSubscriptionAdapter();
    const status = await adapter.auth_status();
    expect(status.authenticated).toBe(true);
    expect(status.subscription_auth).toBe(true);
    expect(status.usable_for_noninteractive).toBe(false);
  });

  test("no fail-fast when ANTHROPIC_API_KEY is set (API key present)", async () => {
    // With API key set, auth_status() should show usable_for_noninteractive:true
    // and the work call should proceed (or fail for other reasons, not sub-auth).
    const dir = makeFakeBinary("claude", 'echo "2.1.114"');
    const spawnCalls: number[] = [];
    const countingSpawn = (input: SpawnCliInput): Promise<SpawnCliResult> => {
      spawnCalls.push(1);
      // Simulate a failed call so we don't need real output parsing.
      return Promise.resolve({
        ok: true,
        exitCode: 1,
        stdout: "",
        stderr: "some other error",
      });
    };
    const adapter = new ClaudeAdapter({
      host: { PATH: dir, HOME: "/tmp", ANTHROPIC_API_KEY: "sk-ant-fake" },
      spawn: countingSpawn,
    });
    // ask() should reach spawn (and fail with non-subscription error)
    let thrown: unknown;
    try {
      await adapter.ask(SAMPLE_ASK);
    } catch (e) {
      thrown = e;
    }
    // The spawn was called — not blocked by subscription check
    expect(spawnCalls.length).toBeGreaterThan(0);
    // Should NOT be subscription_auth_unsupported
    if (thrown instanceof ClaudeAdapterError) {
      expect(thrown.payload.reason).not.toBe("subscription_auth_unsupported");
    }
  });
});
