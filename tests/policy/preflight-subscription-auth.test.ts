// Copyright 2026 Nikolay Samokhvalov.

// Tests for #48: preflight with OAuth (subscription-auth) adapters.
//
// OAuth is the PRIMARY auth mode (#48 reverts #47's "API key required"
// framing). When an adapter's subscription_auth:true, per-adapter line
// is "unknown — OAuth (no per-token cost visibility)" (NOT "API key required").
// likelyUsd excludes it. Warnings mention wall-clock + iteration caps.
// The run is NOT blocked.

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

describe("preflight — OAuth adapter shows 'OAuth' label (not 'API key required')", () => {
  test("per-adapter usd string is 'unknown — OAuth (no per-token cost visibility)'", () => {
    const subLead = mkAdapter("lead", "claude", true, "lead");
    const cfg = mkConfig();
    const r = computePreflight(cfg, [subLead, REVA, REVB]);
    const perLead = r.perAdapter["lead"];
    expect(perLead).toBeDefined();
    expect(perLead?.usd).toBe("unknown — OAuth (no per-token cost visibility)");
  });

  test("pretty-printer includes 'OAuth' in per-adapter line (not 'API key required')", () => {
    const subLead = mkAdapter("lead", "claude", true, "lead");
    const cfg = mkConfig();
    const r = computePreflight(cfg, [subLead, REVA, REVB]);
    const text = formatPreflight(r);
    expect(text).toContain("OAuth");
    expect(text).not.toContain("API key required");
  });

  test("likelyUsd excludes OAuth adapter", () => {
    const subLead = mkAdapter("lead", "claude", true, "lead");
    const rAll = computePreflight(mkConfig(), [LEAD, REVA, REVB]);
    const rSub = computePreflight(mkConfig(), [subLead, REVA, REVB]);
    // OAuth lead excluded -> likelyUsd is smaller
    expect(rSub.likelyUsd).toBeLessThan(rAll.likelyUsd);
  });

  test("warnings list mentions OAuth and caps (not 'API key required')", () => {
    const subLead = mkAdapter("lead", "claude", true, "lead");
    const cfg = mkConfig();
    const r = computePreflight(cfg, [subLead, REVA, REVB]);
    const hasOAuthWarning = r.warnings.some((w) =>
      w.toLowerCase().includes("oauth"),
    );
    expect(hasOAuthWarning).toBe(true);
    const hasApiKeyRequired = r.warnings.some((w) =>
      w.toLowerCase().includes("api key required"),
    );
    expect(hasApiKeyRequired).toBe(false);
  });

  test("two OAuth adapters: both show OAuth label", () => {
    const subLead = mkAdapter("lead", "claude", true, "lead");
    const subRevB = mkAdapter("reviewer_b", "claude", true, "reviewer_b");
    const cfg = mkConfig();
    const r = computePreflight(cfg, [subLead, REVA, subRevB]);
    expect(r.perAdapter["lead"]?.usd).toBe(
      "unknown — OAuth (no per-token cost visibility)",
    );
    expect(r.perAdapter["reviewer_b"]?.usd).toBe(
      "unknown — OAuth (no per-token cost visibility)",
    );
  });

  test("warning count mentions number of OAuth adapters", () => {
    const subLead = mkAdapter("lead", "claude", true, "lead");
    const subRevB = mkAdapter("reviewer_b", "claude", true, "reviewer_b");
    const cfg = mkConfig();
    const r = computePreflight(cfg, [subLead, REVA, subRevB]);
    const countWarning = r.warnings.some(
      (w) => w.includes("2") && /oauth/i.test(w),
    );
    expect(countWarning).toBe(true);
  });
});

describe("preflight — API-key adapters unchanged by OAuth changes", () => {
  test("all API-key adapters: no OAuth warning", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [LEAD, REVA, REVB]);
    const hasSubscriptionWarning = r.warnings.some((w) =>
      /oauth|subscription/i.test(w),
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
