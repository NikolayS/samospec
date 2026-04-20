// Copyright 2026 Nikolay Samokhvalov.

// Tests for #48: doctor auth check with OAuth (subscription-auth) adapters.
//
// OAuth is the PRIMARY auth mode (#48). subscription_auth:true is a
// valid, supported state. The old "WARN because usable_for_noninteractive:false"
// behavior (from #47) is removed.
//
// New behavior: auth check runs a live probe and reports:
//   - OK  — probe succeeds (OAuth session is working)
//   - OK  — API key auth (probe succeeds)
//   - WARN — probe fails with "Invalid API key" (stale env var)
//   - WARN — probe fails with other reason (not logged in, timeout)
//   - FAIL — adapter not authenticated

import { describe, expect, test } from "bun:test";

import { checkAuthStatus } from "../../src/cli/doctor-checks/auth.ts";
import { CheckStatus } from "../../src/cli/doctor-format.ts";
import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";

describe("doctor auth check — OAuth (subscription_auth:true) is OK when probe passes", () => {
  test("OK when claude subscription_auth:true and probe succeeds", async () => {
    const claude = createFakeAdapter({
      auth: {
        authenticated: true,
        subscription_auth: true,
      },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
      probe: () =>
        Promise.resolve({ ok: true, exitCode: 0, stdout: "hi", stderr: "" }),
    });
    expect(result.status).toBe(CheckStatus.Ok);
  });

  test("OK when codex subscription_auth:true and probe succeeds", async () => {
    const codex = createFakeAdapter({
      auth: {
        authenticated: true,
        subscription_auth: true,
      },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "codex", adapter: codex }],
      probe: () =>
        Promise.resolve({
          ok: true,
          exitCode: 0,
          stdout: "answer",
          stderr: "",
        }),
    });
    expect(result.status).toBe(CheckStatus.Ok);
  });

  test("OK when subscription_auth:false and probe succeeds", async () => {
    const claude = createFakeAdapter({
      auth: {
        authenticated: true,
        subscription_auth: false,
      },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
      probe: () =>
        Promise.resolve({ ok: true, exitCode: 0, stdout: "hi", stderr: "" }),
    });
    expect(result.status).toBe(CheckStatus.Ok);
  });
});

describe("doctor auth check — probe fails → WARN (stale key or not logged in)", () => {
  test("WARN when probe stdout contains 'Invalid API key'", async () => {
    const claude = createFakeAdapter({
      auth: { authenticated: true, subscription_auth: true },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
      probe: () =>
        Promise.resolve({
          ok: true,
          exitCode: 1,
          stdout: "Invalid API key · Fix external API key",
          stderr: "",
        }),
    });
    expect(result.status).toBe(CheckStatus.Warn);
  });

  test("WARN message mentions ANTHROPIC_API_KEY for claude", async () => {
    const claude = createFakeAdapter({
      auth: { authenticated: true, subscription_auth: true },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
      probe: () =>
        Promise.resolve({
          ok: true,
          exitCode: 1,
          stdout: "Invalid API key",
          stderr: "",
        }),
    });
    expect(result.message).toContain("ANTHROPIC_API_KEY");
  });

  test("WARN when probe indicates not authenticated", async () => {
    const claude = createFakeAdapter({
      auth: { authenticated: true, subscription_auth: true },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
      probe: () =>
        Promise.resolve({
          ok: true,
          exitCode: 1,
          stdout: "not authenticated",
          stderr: "",
        }),
    });
    expect(result.status).toBe(CheckStatus.Warn);
  });

  test("WARN message for codex mentions OPENAI_API_KEY on stale-key", async () => {
    const codex = createFakeAdapter({
      auth: { authenticated: true, subscription_auth: true },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "codex", adapter: codex }],
      probe: () =>
        Promise.resolve({
          ok: true,
          exitCode: 1,
          stdout: "Invalid API key",
          stderr: "",
        }),
    });
    expect(result.message).toContain("OPENAI_API_KEY");
  });
});

describe("doctor auth check — not authenticated → FAIL (no probe needed)", () => {
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

  test("FAIL takes priority over probe WARN when an adapter is not authenticated", async () => {
    const claudeOk = createFakeAdapter({
      auth: { authenticated: true, subscription_auth: true },
    });
    const codexNotAuth = createFakeAdapter({
      auth: { authenticated: false },
    });
    // First adapter probe would fail (stale key), but codex is not
    // authenticated — FAIL takes priority.
    const result = await checkAuthStatus({
      adapters: [
        { label: "claude", adapter: claudeOk },
        { label: "codex", adapter: codexNotAuth },
      ],
      probe: (label) =>
        Promise.resolve(
          label === "claude"
            ? { ok: true, exitCode: 0, stdout: "hi", stderr: "" }
            : { ok: true, exitCode: 0, stdout: "hi", stderr: "" },
        ),
    });
    expect(result.status).toBe(CheckStatus.Fail);
  });
});

describe("doctor auth check — mixed adapters", () => {
  test("WARN when one probe fails, other succeeds", async () => {
    const claude = createFakeAdapter({
      auth: { authenticated: true, subscription_auth: true },
    });
    const codex = createFakeAdapter({
      auth: { authenticated: true, subscription_auth: false },
    });
    const result = await checkAuthStatus({
      adapters: [
        { label: "claude", adapter: claude },
        { label: "codex", adapter: codex },
      ],
      probe: (label) =>
        Promise.resolve(
          label === "claude"
            ? {
                ok: true,
                exitCode: 1,
                stdout: "Invalid API key",
                stderr: "",
              }
            : { ok: true, exitCode: 0, stdout: "answer", stderr: "" },
        ),
    });
    expect(result.status).toBe(CheckStatus.Warn);
  });
});
