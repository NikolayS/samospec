// Copyright 2026 Nikolay Samokhvalov.

// Integration test for Issue #48: asserts that runDoctor() wires the live
// auth probe through to checkAuthStatus(), not just calling it directly.
//
// The bug: line 166 of doctor.ts called checkAuthStatus({ adapters }) without
// passing probe, so the stale-key-preempting-OAuth case was never caught in
// production even though the unit tests for checkAuthStatus passed fine (they
// inject probe themselves).
//
// This test exercises the full runDoctor() path with a probe injected at the
// RunDoctorArgs level (the authProbe field), confirming that runDoctor forwards
// it to checkAuthStatus.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runDoctor } from "../../src/cli/doctor.ts";
import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import { runInit } from "../../src/cli/init.ts";

let tmp: string;
let fakeHome: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-probe-integ-"));
  fakeHome = mkdtempSync(path.join(tmpdir(), "samospec-home-"));
  runInit({ cwd: tmp });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

// OAuth adapter: auth_status() says authenticated via subscription_auth:true,
// which is the exact case where a stale ANTHROPIC_API_KEY can preempt OAuth.
function makeOAuthAdapter() {
  return createFakeAdapter({
    auth: { authenticated: true, subscription_auth: true },
    detect: { installed: true, version: "1.0.0", path: "/usr/bin/claude" },
  });
}

describe("runDoctor — wires authProbe into checkAuthStatus (#48)", () => {
  test("WARN with stale-key guidance when probe returns 'Invalid API key'", async () => {
    // Probe simulates the live claude -p returning "Invalid API key".
    const staleKeyProbe = () =>
      Promise.resolve({
        ok: false,
        exitCode: 1,
        stdout: "Invalid API key · Fix external API key",
        stderr: "",
      });

    const result = await runDoctor({
      cwd: tmp,
      homeDir: fakeHome,
      adapters: [{ label: "claude", adapter: makeOAuthAdapter() }],
      authProbe: staleKeyProbe,
      isGitRepo: () => true,
      currentBranch: () => "feature/probe-test",
      hasRemote: () => false,
      remoteUrl: () => null,
      isProtected: () => false,
      ghRunner: () => ({ status: 0, stdout: "Logged in", stderr: "" }),
      env: { NO_COLOR: "1" },
    });

    // runDoctor must surface a WARN (not OK) because the probe revealed the
    // stale-key problem. Without the fix, probe is not passed and result is OK.
    expect(result.exitCode).toBe(0); // WARN does not cause a non-zero exit
    expect(result.stdout).toContain("WARN");
    expect(result.stdout).toContain("ANTHROPIC_API_KEY");
    // The specific stale-key-preempting-OAuth guidance must appear.
    expect(
      result.stdout.toLowerCase().includes("unset") ||
        result.stdout.toLowerCase().includes("stale") ||
        result.stdout.toLowerCase().includes("preempting"),
    ).toBe(true);
  });

  test("OK when authProbe is injected and succeeds", async () => {
    const happyProbe = () =>
      Promise.resolve({ ok: true, exitCode: 0, stdout: "hi", stderr: "" });

    const result = await runDoctor({
      cwd: tmp,
      homeDir: fakeHome,
      adapters: [{ label: "claude", adapter: makeOAuthAdapter() }],
      authProbe: happyProbe,
      isGitRepo: () => true,
      currentBranch: () => "feature/probe-test",
      hasRemote: () => false,
      remoteUrl: () => null,
      isProtected: () => false,
      ghRunner: () => ({ status: 0, stdout: "Logged in", stderr: "" }),
      env: { NO_COLOR: "1" },
    });

    expect(result.exitCode).toBe(0);
    // Auth row should be OK (authenticated, no WARN from probe).
    const authLine = result.stdout.split("\n").find((l) => l.includes("auth"));
    expect(authLine).toBeDefined();
    expect(authLine).toContain("OK");
  });
});
