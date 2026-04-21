// Copyright 2026 Nikolay Samokhvalov.

// RED tests for Issue #70: Codex adapter auth_status() must return
// subscription_auth: true when OPENAI_API_KEY is absent (ChatGPT OAuth).
//
// The bug: under ChatGPT OAuth (no OPENAI_API_KEY), reviewer_a was shown
// with a dollar estimate in preflight instead of "unknown — OAuth".
// Root cause: auth_status() was not reliably returning subscription_auth
// when the binary is present but OPENAI_API_KEY is unset.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAdapter } from "../../src/adapter/codex.ts";

const TMP: string[] = [];

function makeFakeBinaryDir(name: string): {
  dir: string;
  binary: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "samospec-codex70-bin-"));
  TMP.push(dir);
  const binary = join(dir, name);
  // Script that echoes a version string (used by probeVersion).
  writeFileSync(binary, `#!/usr/bin/env bash\necho "0.99.0"\n`);
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

// ---------- tests ----------

describe("#70 — CodexAdapter.auth_status(): ChatGPT OAuth (no OPENAI_API_KEY)", () => {
  test("no OPENAI_API_KEY + binary installed → subscription_auth: true", async () => {
    const { dir } = makeFakeBinaryDir("codex");
    // Host env without OPENAI_API_KEY — simulates ChatGPT OAuth mode.
    const host: Record<string, string | undefined> = {
      PATH: dir,
      HOME: "/tmp",
      // OPENAI_API_KEY deliberately absent.
    };
    const adapter = new CodexAdapter({ host });
    const status = await adapter.auth_status();

    expect(status.authenticated).toBe(true);
    // KEY assertion: must be true when no API key is set.
    expect(status.subscription_auth).toBe(true);
  });

  test("OPENAI_API_KEY set + binary installed → subscription_auth: false", async () => {
    const { dir } = makeFakeBinaryDir("codex");
    const host: Record<string, string | undefined> = {
      PATH: dir,
      HOME: "/tmp",
      OPENAI_API_KEY: "sk-test-not-a-real-key",
    };
    const adapter = new CodexAdapter({ host });
    const status = await adapter.auth_status();

    expect(status.authenticated).toBe(true);
    // With API key set, subscription_auth must be false.
    expect(status.subscription_auth).toBe(false);
  });

  test("OPENAI_API_KEY empty string + binary installed → subscription_auth: true", async () => {
    const { dir } = makeFakeBinaryDir("codex");
    const host: Record<string, string | undefined> = {
      PATH: dir,
      HOME: "/tmp",
      OPENAI_API_KEY: "",
    };
    const adapter = new CodexAdapter({ host });
    const status = await adapter.auth_status();

    expect(status.authenticated).toBe(true);
    // Empty string is not a valid API key — treated as absent.
    expect(status.subscription_auth).toBe(true);
  });

  test("binary not installed → authenticated: false, subscription_auth absent/false", async () => {
    const host: Record<string, string | undefined> = {
      PATH: "/no/such/path",
      HOME: "/tmp",
    };
    const adapter = new CodexAdapter({ host });
    const status = await adapter.auth_status();

    expect(status.authenticated).toBe(false);
    expect(status.subscription_auth).toBeFalsy();
  });
});
