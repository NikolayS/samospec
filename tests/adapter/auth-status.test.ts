// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import { detectSubscriptionAuth } from "../../src/adapter/auth-status.ts";

describe("detectSubscriptionAuth (SPEC §11 escape)", () => {
  test("ANTHROPIC_API_KEY present -> NOT subscription auth", () => {
    const r = detectSubscriptionAuth({
      vendor: "claude",
      authenticated: true,
      env: { ANTHROPIC_API_KEY: "sk-ant-..." },
    });
    expect(r).toBe(false);
  });

  test("authenticated but no API-key env var -> subscription auth", () => {
    const r = detectSubscriptionAuth({
      vendor: "claude",
      authenticated: true,
      env: {},
    });
    expect(r).toBe(true);
  });

  test("not authenticated -> subscription_auth undefined (false)", () => {
    const r = detectSubscriptionAuth({
      vendor: "claude",
      authenticated: false,
      env: {},
    });
    expect(r).toBe(false);
  });

  test("codex + authenticated + OPENAI_API_KEY set -> NOT subscription auth", () => {
    const r = detectSubscriptionAuth({
      vendor: "codex",
      authenticated: true,
      env: { OPENAI_API_KEY: "sk-..." },
    });
    expect(r).toBe(false);
  });

  test("codex + authenticated + no OPENAI_API_KEY -> subscription auth (ChatGPT login)", () => {
    // As of Sprint 3 (#23), Codex CLI supports ChatGPT-subscription auth
    // in addition to the API-key path. With no API-key env var and an
    // authenticated CLI, treat as subscription auth (usage: null path).
    const r = detectSubscriptionAuth({
      vendor: "codex",
      authenticated: true,
      env: {},
    });
    expect(r).toBe(true);
  });

  test("claude + authenticated + ANTHROPIC_API_KEY empty string -> subscription auth", () => {
    const r = detectSubscriptionAuth({
      vendor: "claude",
      authenticated: true,
      env: { ANTHROPIC_API_KEY: "" },
    });
    expect(r).toBe(true);
  });
});
