// Copyright 2026 Nikolay Samokhvalov.

// RED tests for #45 + #46: preflight with subscription-auth adapters.
//
// Per SPEC §11 (updated): when an adapter's subscription_auth:true and
// no API key is present, per-adapter line is
// "unknown — subscription auth (API key required)" and likelyUsd excludes it.

import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../../src/cli/init.ts";
import {
  computePreflight,
  formatPreflight,
  type PreflightAdapter,
  type PreflightConfig,
} from "../../src/policy/preflight.ts";

function mkConfig(overrides: Partial<PreflightConfig> = {}): PreflightConfig {
  const baseline: PreflightConfig = {
    adapters: {
      lead: { ...DEFAULT_CONFIG.adapters.lead },
      reviewer_a: { ...DEFAULT_CONFIG.adapters.reviewer_a },
      reviewer_b: { ...DEFAULT_CONFIG.adapters.reviewer_b },
    },
    budget: { ...DEFAULT_CONFIG.budget },
    calibration: null,
  };
  return { ...baseline, ...overrides };
}

function mkAdapter(
  id: string,
  vendor: string,
  subscription_auth: boolean,
  role: "lead" | "reviewer_a" | "reviewer_b",
): PreflightAdapter {
  return { id, vendor, role, subscription_auth };
}

const LEAD = mkAdapter("lead", "claude", false, "lead");
const REVA = mkAdapter("reviewer_a", "codex", false, "reviewer_a");
const REVB = mkAdapter("reviewer_b", "claude", false, "reviewer_b");

describe("preflight — subscription-auth shows 'API key required' in per-adapter line", () => {
  test("per-adapter usd string is 'unknown — subscription auth (API key required)'", () => {
    const subLead = mkAdapter("lead", "claude", true, "lead");
    const cfg = mkConfig();
    const r = computePreflight(cfg, [subLead, REVA, REVB]);
    const perLead = r.perAdapter["lead"];
    expect(perLead).toBeDefined();
    expect(perLead?.usd).toBe("unknown — subscription auth (API key required)");
  });

  test("pretty-printer includes 'API key required' in per-adapter line", () => {
    const subLead = mkAdapter("lead", "claude", true, "lead");
    const cfg = mkConfig();
    const r = computePreflight(cfg, [subLead, REVA, REVB]);
    const text = formatPreflight(r);
    expect(text).toContain("API key required");
  });

  test("likelyUsd excludes subscription-auth adapter", () => {
    const subLead = mkAdapter("lead", "claude", true, "lead");
    const rAll = computePreflight(mkConfig(), [LEAD, REVA, REVB]);
    const rSub = computePreflight(mkConfig(), [subLead, REVA, REVB]);
    // Subscription lead excluded -> likelyUsd is smaller
    expect(rSub.likelyUsd).toBeLessThan(rAll.likelyUsd);
  });

  test("warnings list includes 'API key required' mention for subscription adapters", () => {
    const subLead = mkAdapter("lead", "claude", true, "lead");
    const cfg = mkConfig();
    const r = computePreflight(cfg, [subLead, REVA, REVB]);
    const hasApiKeyWarning = r.warnings.some((w) =>
      w.toLowerCase().includes("api key"),
    );
    expect(hasApiKeyWarning).toBe(true);
  });

  test("two subscription adapters: both show API key required", () => {
    const subLead = mkAdapter("lead", "claude", true, "lead");
    const subRevB = mkAdapter("reviewer_b", "claude", true, "reviewer_b");
    const cfg = mkConfig();
    const r = computePreflight(cfg, [subLead, REVA, subRevB]);
    expect(r.perAdapter["lead"]?.usd).toBe(
      "unknown — subscription auth (API key required)",
    );
    expect(r.perAdapter["reviewer_b"]?.usd).toBe(
      "unknown — subscription auth (API key required)",
    );
  });

  test("warning count mentions number of subscription adapters", () => {
    const subLead = mkAdapter("lead", "claude", true, "lead");
    const subRevB = mkAdapter("reviewer_b", "claude", true, "reviewer_b");
    const cfg = mkConfig();
    const r = computePreflight(cfg, [subLead, REVA, subRevB]);
    const countWarning = r.warnings.some(
      (w) => w.includes("2") && /subscription/i.test(w),
    );
    expect(countWarning).toBe(true);
  });
});

describe("preflight — API-key adapters unchanged by subscription changes", () => {
  test("all API-key adapters: no subscription warning", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [LEAD, REVA, REVB]);
    const hasSubscriptionWarning = r.warnings.some((w) =>
      /subscription/i.test(w),
    );
    expect(hasSubscriptionWarning).toBe(false);
  });

  test("all API-key adapters: per-adapter usd is numeric", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [LEAD, REVA, REVB]);
    for (const [, entry] of Object.entries(r.perAdapter)) {
      expect(typeof entry.usd).toBe("number");
    }
  });
});
