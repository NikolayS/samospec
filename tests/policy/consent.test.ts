// Copyright 2026 Nikolay Samokhvalov.

// SPEC §5 Phase 1 + §11 preflight consent gate.
//
// Red-first contract:
//   1. When `likelyUsd <= preflight_confirm_usd` AND no adapter has
//      `usage: null` risk -> no prompt needed (auto-accept).
//   2. When `likelyUsd > preflight_confirm_usd` -> prompt; caller's
//      `answer` is one of accept / downshift / abort.
//   3. When any adapter has `usage_unknown` flag (usage: null) ->
//      prompt fires even below the dollar threshold.
//   4. `accept` decision: sessionEffort undefined.
//   5. `abort` decision: exit 5 per SPEC §10.
//   6. `downshift` decision: sessionEffort === 'high' (SPEC §11 effort
//      ladder; 'high' is the first step down from 'max').

import { describe, expect, test } from "bun:test";

import {
  promptConsent,
  shouldPromptConsent,
  CONSENT_ABORT_EXIT_CODE,
  type PreflightForConsent,
} from "../../src/policy/consent.ts";

// ---------- shouldPromptConsent ----------

describe("shouldPromptConsent", () => {
  const base: PreflightForConsent = {
    likelyUsd: 5,
    anyUsageNull: false,
  };

  test("auto-accepts when likely cost <= threshold and no usage-null risk", () => {
    expect(shouldPromptConsent(base, 20)).toBe(false);
  });

  test("prompts when likely cost exceeds threshold", () => {
    const over: PreflightForConsent = { likelyUsd: 25, anyUsageNull: false };
    expect(shouldPromptConsent(over, 20)).toBe(true);
  });

  test("prompts when any adapter returned usage: null (price not measurable)", () => {
    const risky: PreflightForConsent = { likelyUsd: 1, anyUsageNull: true };
    expect(shouldPromptConsent(risky, 20)).toBe(true);
  });

  test("boundary: exactly equal to threshold does NOT prompt", () => {
    const eq: PreflightForConsent = { likelyUsd: 20, anyUsageNull: false };
    expect(shouldPromptConsent(eq, 20)).toBe(false);
  });
});

// ---------- promptConsent with injected answer ----------

describe("promptConsent — injected answer (no TTY required)", () => {
  const preflight: PreflightForConsent = { likelyUsd: 25, anyUsageNull: false };

  test("'accept' returns a decision with no session effort change", () => {
    const r = promptConsent({
      preflight,
      thresholdUsd: 20,
      answer: "accept",
    });
    expect(r.decision).toBe("accept");
    expect(r.exitCode).toBeUndefined();
    expect(r.sessionEffort).toBeUndefined();
  });

  test("'downshift' sets sessionEffort=high (not persisted)", () => {
    const r = promptConsent({
      preflight,
      thresholdUsd: 20,
      answer: "downshift",
    });
    expect(r.decision).toBe("downshift");
    expect(r.sessionEffort).toBe("high");
    expect(r.persist).toBe(false);
  });

  test("'abort' returns exit code 5 per SPEC §10", () => {
    const r = promptConsent({
      preflight,
      thresholdUsd: 20,
      answer: "abort",
    });
    expect(r.decision).toBe("abort");
    expect(r.exitCode).toBe(5);
    expect(CONSENT_ABORT_EXIT_CODE).toBe(5);
  });

  test("unknown answer string is treated as abort for safety", () => {
    const r = promptConsent({
      preflight,
      thresholdUsd: 20,
      answer: "banana" as unknown as "accept",
    });
    expect(r.decision).toBe("abort");
  });
});

// ---------- auto-path when no prompt is required ----------

describe("promptConsent — auto path (below threshold, no usage-null)", () => {
  test("returns accept without asking when no prompt is warranted", () => {
    const cheap: PreflightForConsent = {
      likelyUsd: 5,
      anyUsageNull: false,
    };
    const r = promptConsent({
      preflight: cheap,
      thresholdUsd: 20,
      // No answer supplied; function should auto-accept and not throw.
    });
    expect(r.decision).toBe("accept");
  });
});

// ---------- missing-answer path when prompt is warranted ----------

describe("promptConsent — missing answer but prompt required", () => {
  test("throws an explicit error so callers hook up an answerer", () => {
    const pricey: PreflightForConsent = {
      likelyUsd: 50,
      anyUsageNull: false,
    };
    expect(() =>
      promptConsent({ preflight: pricey, thresholdUsd: 20 }),
    ).toThrow();
  });
});
