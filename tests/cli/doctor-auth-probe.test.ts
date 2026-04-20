// Copyright 2026 Nikolay Samokhvalov.

// RED tests for #48: doctor auth check with live probe behavior.
//
// The new doctor auth check runs a small live probe (echo "probe" | claude -p)
// and classifies the result:
//   - Probe succeeds (exit 0, sensible output) → OK
//   - Probe stdout contains "Invalid API key" → WARN with stale-key guidance
//   - Probe output indicates not authenticated → WARN with login guidance
//   - Other failures → WARN with generic message
//
// These tests use a mock probe helper injected via the checkAuthStatus args.

import { describe, expect, test } from "bun:test";

import { checkAuthStatus } from "../../src/cli/doctor-checks/auth.ts";
import { CheckStatus } from "../../src/cli/doctor-format.ts";
import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";

// A fake adapter in OAuth mode (no API key, subscription_auth:true).
function makeOAuthAdapter() {
  return createFakeAdapter({
    auth: {
      authenticated: true,
      subscription_auth: true,
    },
  });
}

// A fake adapter with API key (normal authenticated mode).
function makeApiKeyAdapter() {
  return createFakeAdapter({
    auth: {
      authenticated: true,
      subscription_auth: false,
    },
  });
}

describe("doctor auth probe — probe succeeds → OK", () => {
  test("OK when probe returns exit 0 (OAuth session working)", async () => {
    const claude = makeOAuthAdapter();
    const probeResult = { ok: true, exitCode: 0, stdout: "hi", stderr: "" };
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
      probe: () => Promise.resolve(probeResult),
    });
    expect(result.status).toBe(CheckStatus.Ok);
  });

  test("OK when API key adapter and probe succeeds", async () => {
    const claude = makeApiKeyAdapter();
    const probeResult = { ok: true, exitCode: 0, stdout: "answer", stderr: "" };
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
      probe: () => Promise.resolve(probeResult),
    });
    expect(result.status).toBe(CheckStatus.Ok);
  });
});

describe("doctor auth probe — 'Invalid API key' in stdout → WARN stale key", () => {
  test("WARN when probe stdout contains 'Invalid API key'", async () => {
    const claude = makeOAuthAdapter();
    const probeResult = {
      ok: true,
      exitCode: 1,
      stdout: "Invalid API key · Fix external API key",
      stderr: "",
    };
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
      probe: () => Promise.resolve(probeResult),
    });
    expect(result.status).toBe(CheckStatus.Warn);
  });

  test("WARN message mentions stale ANTHROPIC_API_KEY", async () => {
    const claude = makeOAuthAdapter();
    const probeResult = {
      ok: true,
      exitCode: 1,
      stdout: "Invalid API key · Fix external API key",
      stderr: "",
    };
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
      probe: () => Promise.resolve(probeResult),
    });
    expect(result.message).toContain("ANTHROPIC_API_KEY");
  });

  test("WARN message suggests unsetting the env var", async () => {
    const claude = makeOAuthAdapter();
    const probeResult = {
      ok: true,
      exitCode: 1,
      stdout: "Invalid API key · Fix external API key",
      stderr: "",
    };
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
      probe: () => Promise.resolve(probeResult),
    });
    // Should mention unsetting or the stale-key framing
    const lower = result.message.toLowerCase();
    expect(
      lower.includes("unset") ||
        lower.includes("stale") ||
        lower.includes("preempting"),
    ).toBe(true);
  });

  test("WARN message mentions console.anthropic.com for API key verification", async () => {
    const claude = makeOAuthAdapter();
    const probeResult = {
      ok: true,
      exitCode: 1,
      stdout: "Invalid API key",
      stderr: "",
    };
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
      probe: () => Promise.resolve(probeResult),
    });
    expect(result.message).toContain("console.anthropic.com");
  });
});

describe("doctor auth probe — not authenticated → WARN login guidance", () => {
  test("WARN when probe indicates not authenticated", async () => {
    const claude = makeOAuthAdapter();
    const probeResult = {
      ok: true,
      exitCode: 1,
      stdout: "please run claude /login",
      stderr: "",
    };
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
      probe: () => Promise.resolve(probeResult),
    });
    expect(result.status).toBe(CheckStatus.Warn);
  });

  test("WARN message mentions claude /login", async () => {
    const claude = makeOAuthAdapter();
    const probeResult = {
      ok: true,
      exitCode: 1,
      stdout: "not authenticated",
      stderr: "",
    };
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
      probe: () => Promise.resolve(probeResult),
    });
    expect(result.message.toLowerCase()).toContain("login");
  });
});

describe("doctor auth probe — other failure → WARN generic", () => {
  test("WARN on other probe failure (timeout or unknown stderr)", async () => {
    const claude = makeOAuthAdapter();
    const probeResult = {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: "connection timed out",
    };
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
      probe: () => Promise.resolve(probeResult),
    });
    expect(result.status).toBe(CheckStatus.Warn);
  });

  test("WARN message includes first line of stderr on generic failure", async () => {
    const claude = makeOAuthAdapter();
    const probeResult = {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: "connection timed out\nmore details",
    };
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
      probe: () => Promise.resolve(probeResult),
    });
    expect(result.message).toContain("connection timed out");
  });
});

describe("doctor auth — adapter not authenticated (FAIL, no probe needed)", () => {
  test("FAIL when adapter not authenticated", async () => {
    const claude = createFakeAdapter({
      auth: { authenticated: false },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
      probe: () =>
        Promise.resolve({ ok: true, exitCode: 0, stdout: "hi", stderr: "" }),
    });
    expect(result.status).toBe(CheckStatus.Fail);
  });
});
