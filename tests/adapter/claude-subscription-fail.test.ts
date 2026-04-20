// Copyright 2026 Nikolay Samokhvalov.

// Tests for #48: Claude adapter in OAuth (subscription) mode.
//
// OAuth is the PRIMARY auth mode (#48 reverts #47's fail-fast gate).
// When subscription_auth:true (no ANTHROPIC_API_KEY), work calls
// proceed to spawn — they do NOT throw subscription_auth_unsupported.
//
// The old "fail-fast before spawn" behavior was introduced by PR #47
// and has been reverted. This file is repurposed to verify the
// correct OAuth-primary semantics.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAdapter } from "../../src/adapter/claude.ts";
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
  const dir = mkdtempSync(join(tmpdir(), "samospec-sub-oauth-"));
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

function makeOAuthAdapterWithCountingSpy(): {
  adapter: ClaudeAdapter;
  spawnCalls: number[];
} {
  const dir = makeFakeBinary("claude", 'echo "2.1.114"');
  const spawnCalls: number[] = [];
  const countingSpawn = (_input: SpawnCliInput): Promise<SpawnCliResult> => {
    spawnCalls.push(1);
    return Promise.resolve({
      ok: true,
      exitCode: 1,
      stdout: "",
      stderr: "test stub: non-zero exit",
    });
  };
  const adapter = new ClaudeAdapter({
    host: { PATH: dir, HOME: "/tmp" }, // no ANTHROPIC_API_KEY
    spawn: countingSpawn,
  });
  return { adapter, spawnCalls };
}

describe("ClaudeAdapter — OAuth mode (subscription_auth:true) — work calls proceed", () => {
  test("auth_status() reports authenticated:true with subscription_auth:true", async () => {
    const { adapter } = makeOAuthAdapterWithCountingSpy();
    const status = await adapter.auth_status();
    expect(status.authenticated).toBe(true);
    expect(status.subscription_auth).toBe(true);
  });

  test("auth_status() does NOT report usable_for_noninteractive:false (#48)", async () => {
    const { adapter } = makeOAuthAdapterWithCountingSpy();
    const status = await adapter.auth_status();
    // OAuth is the primary mode — the flag is no longer set to false
    expect(status.usable_for_noninteractive).not.toBe(false);
  });

  test("ask() proceeds to spawn (does not short-circuit)", async () => {
    const { adapter, spawnCalls } = makeOAuthAdapterWithCountingSpy();
    try {
      await adapter.ask(SAMPLE_ASK);
    } catch {
      // Expected to fail from stub, but spawn must have been called
    }
    expect(spawnCalls.length).toBeGreaterThan(0);
  });

  test("critique() proceeds to spawn (does not short-circuit)", async () => {
    const { adapter, spawnCalls } = makeOAuthAdapterWithCountingSpy();
    try {
      await adapter.critique(SAMPLE_CRITIQUE);
    } catch {
      // Expected to fail from stub, but spawn must have been called
    }
    expect(spawnCalls.length).toBeGreaterThan(0);
  });

  test("revise() proceeds to spawn (does not short-circuit)", async () => {
    const { adapter, spawnCalls } = makeOAuthAdapterWithCountingSpy();
    try {
      await adapter.revise(SAMPLE_REVISE);
    } catch {
      // Expected to fail from stub, but spawn must have been called
    }
    expect(spawnCalls.length).toBeGreaterThan(0);
  });

  test("no fail-fast when ANTHROPIC_API_KEY is set (API key present)", async () => {
    const dir = makeFakeBinary("claude", 'echo "2.1.114"');
    const spawnCalls: number[] = [];
    const countingSpawn = (_input: SpawnCliInput): Promise<SpawnCliResult> => {
      spawnCalls.push(1);
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
    try {
      await adapter.ask(SAMPLE_ASK);
    } catch {
      // Expected failure, not subscription_auth_unsupported
    }
    expect(spawnCalls.length).toBeGreaterThan(0);
  });
});
