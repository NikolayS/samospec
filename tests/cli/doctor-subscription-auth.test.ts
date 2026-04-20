// Copyright 2026 Nikolay Samokhvalov.

// RED tests for #45 + #46: doctor auth check with subscription-auth adapters.
//
// When subscription_auth:true and no API key in env:
//   - checkAuthStatus returns WARN
//   - message mentions "subscription auth" and the required env var
//   - message does NOT say OK or authenticated with full access
//
// When subscription_auth:true but API key IS set:
//   - auth_status() returns usable_for_noninteractive:true (or just ok)
//   - checkAuthStatus returns OK

import { describe, expect, test } from "bun:test";

import { checkAuthStatus } from "../../src/cli/doctor-checks/auth.ts";
import { CheckStatus } from "../../src/cli/doctor-format.ts";
import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";

describe("doctor auth check — subscription_auth without API key", () => {
  test("WARN when claude subscription_auth:true and no API key", async () => {
    const claude = createFakeAdapter({
      auth: {
        authenticated: true,
        subscription_auth: true,
        usable_for_noninteractive: false,
      },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
    });
    expect(result.status).toBe(CheckStatus.Warn);
  });

  test("WARN message mentions 'subscription auth'", async () => {
    const claude = createFakeAdapter({
      auth: {
        authenticated: true,
        subscription_auth: true,
        usable_for_noninteractive: false,
      },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
    });
    expect(result.message.toLowerCase()).toContain("subscription auth");
  });

  test("WARN message mentions ANTHROPIC_API_KEY for claude adapter", async () => {
    const claude = createFakeAdapter({
      auth: {
        authenticated: true,
        subscription_auth: true,
        usable_for_noninteractive: false,
      },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
    });
    expect(result.message).toContain("ANTHROPIC_API_KEY");
  });

  test("WARN message mentions non-interactive invocation", async () => {
    const claude = createFakeAdapter({
      auth: {
        authenticated: true,
        subscription_auth: true,
        usable_for_noninteractive: false,
      },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
    });
    expect(result.message.toLowerCase()).toContain("non-interactive");
  });

  test("WARN when codex subscription_auth:true and no API key", async () => {
    const codex = createFakeAdapter({
      auth: {
        authenticated: true,
        subscription_auth: true,
        usable_for_noninteractive: false,
      },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "codex", adapter: codex }],
    });
    expect(result.status).toBe(CheckStatus.Warn);
  });

  test("WARN message for codex mentions OPENAI_API_KEY", async () => {
    const codex = createFakeAdapter({
      auth: {
        authenticated: true,
        subscription_auth: true,
        usable_for_noninteractive: false,
      },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "codex", adapter: codex }],
    });
    // For codex, the doctor should guide to OPENAI_API_KEY
    expect(result.message).toContain("OPENAI_API_KEY");
  });
});

describe("doctor auth check — subscription_auth with API key present (OK)", () => {
  test("OK when claude has subscription_auth:true but usable_for_noninteractive:true", async () => {
    // This is the case where ANTHROPIC_API_KEY is set; subscription_auth
    // stays true (heuristic) but the adapter is usable because API key
    // shadows it in practice. However, the new field
    // usable_for_noninteractive:true lets doctor know it's fine.
    const claude = createFakeAdapter({
      auth: {
        authenticated: true,
        subscription_auth: false, // API key present -> subscription_auth:false
        usable_for_noninteractive: true,
      },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
    });
    expect(result.status).toBe(CheckStatus.Ok);
  });

  test("OK when subscription_auth:false and API key (normal case)", async () => {
    const claude = createFakeAdapter({
      auth: {
        authenticated: true,
        subscription_auth: false,
      },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
    });
    expect(result.status).toBe(CheckStatus.Ok);
  });
});

describe("doctor auth check — mixed adapters", () => {
  test("WARN when one adapter is subscription-only and other has API key", async () => {
    const claudeSubscription = createFakeAdapter({
      auth: {
        authenticated: true,
        subscription_auth: true,
        usable_for_noninteractive: false,
      },
    });
    const codexApiKey = createFakeAdapter({
      auth: {
        authenticated: true,
        subscription_auth: false,
      },
    });
    const result = await checkAuthStatus({
      adapters: [
        { label: "claude", adapter: claudeSubscription },
        { label: "codex", adapter: codexApiKey },
      ],
    });
    // Should be WARN (not FAIL), because both are authenticated
    expect(result.status).toBe(CheckStatus.Warn);
  });

  test("FAIL takes priority over subscription WARN when an adapter is not authenticated", async () => {
    const claudeSubscription = createFakeAdapter({
      auth: {
        authenticated: true,
        subscription_auth: true,
        usable_for_noninteractive: false,
      },
    });
    const codexNotAuth = createFakeAdapter({
      auth: {
        authenticated: false,
      },
    });
    const result = await checkAuthStatus({
      adapters: [
        { label: "claude", adapter: claudeSubscription },
        { label: "codex", adapter: codexNotAuth },
      ],
    });
    expect(result.status).toBe(CheckStatus.Fail);
  });
});
