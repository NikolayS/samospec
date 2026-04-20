// Copyright 2026 Nikolay Samokhvalov.

// RED tests for #48: preflight with OAuth (subscription-auth) adapters.
//
// Per SPEC §11 (updated for #48): when an adapter's subscription_auth:true,
// per-adapter line is "unknown — OAuth (no per-token cost visibility)"
// (NOT "API key required"). likelyUsd excludes it. Warnings mention
// wall-clock + iteration caps. The run is NOT blocked.

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

const LEAD_API = mkAdapter("lead", "claude", false, "lead");
const REVA_API = mkAdapter("reviewer_a", "codex", false, "reviewer_a");
const REVB_API = mkAdapter("reviewer_b", "claude", false, "reviewer_b");

const LEAD_OAUTH = mkAdapter("lead", "claude", true, "lead");
const REVB_OAUTH = mkAdapter("reviewer_b", "claude", true, "reviewer_b");

describe("preflight — OAuth adapter shows 'OAuth' label, not 'API key required'", () => {
  test("per-adapter usd string is 'unknown — OAuth (no per-token cost visibility)'", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [LEAD_OAUTH, REVA_API, REVB_API]);
    const perLead = r.perAdapter["lead"];
    expect(perLead).toBeDefined();
    expect(perLead?.usd).toBe("unknown — OAuth (no per-token cost visibility)");
  });

  test("per-adapter usd string does NOT contain 'API key required'", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [LEAD_OAUTH, REVA_API, REVB_API]);
    const perLead = r.perAdapter["lead"];
    expect(String(perLead?.usd)).not.toContain("API key required");
  });

  test("pretty-printer includes 'OAuth' in per-adapter line", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [LEAD_OAUTH, REVA_API, REVB_API]);
    const text = formatPreflight(r);
    expect(text).toContain("OAuth");
  });

  test("pretty-printer does NOT include 'API key required'", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [LEAD_OAUTH, REVA_API, REVB_API]);
    const text = formatPreflight(r);
    expect(text).not.toContain("API key required");
  });
});

describe("preflight — OAuth adapter: likelyUsd excludes it", () => {
  test("likelyUsd excludes OAuth adapter (same as old subscription-auth behavior)", () => {
    const rAll = computePreflight(mkConfig(), [LEAD_API, REVA_API, REVB_API]);
    const rOAuth = computePreflight(mkConfig(), [LEAD_OAUTH, REVA_API, REVB_API]);
    expect(rOAuth.likelyUsd).toBeLessThan(rAll.likelyUsd);
  });
});

describe("preflight — OAuth adapter: warnings mention wall-clock + iteration caps", () => {
  test("warnings list mentions OAuth adapters", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [LEAD_OAUTH, REVA_API, REVB_API]);
    const hasOAuthWarning = r.warnings.some((w) =>
      w.toLowerCase().includes("oauth"),
    );
    expect(hasOAuthWarning).toBe(true);
  });

  test("warnings mention wall-clock or iteration as substitute caps", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [LEAD_OAUTH, REVA_API, REVB_API]);
    const mentionsCaps = r.warnings.some(
      (w) =>
        w.toLowerCase().includes("wall-clock") ||
        w.toLowerCase().includes("iteration"),
    );
    expect(mentionsCaps).toBe(true);
  });

  test("two OAuth adapters: both show OAuth label", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [LEAD_OAUTH, REVA_API, REVB_OAUTH]);
    expect(r.perAdapter["lead"]?.usd).toBe(
      "unknown — OAuth (no per-token cost visibility)",
    );
    expect(r.perAdapter["reviewer_b"]?.usd).toBe(
      "unknown — OAuth (no per-token cost visibility)",
    );
  });

  test("warning count mentions number of OAuth adapters", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [LEAD_OAUTH, REVA_API, REVB_OAUTH]);
    const countWarning = r.warnings.some(
      (w) => w.includes("2") && /oauth/i.test(w),
    );
    expect(countWarning).toBe(true);
  });

  test("warnings list does NOT say 'API key required'", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [LEAD_OAUTH, REVA_API, REVB_API]);
    const hasApiKeyRequired = r.warnings.some((w) =>
      w.toLowerCase().includes("api key required"),
    );
    expect(hasApiKeyRequired).toBe(false);
  });
});

describe("preflight — run is NOT blocked by OAuth adapter", () => {
  test("computePreflight completes without throwing for OAuth adapter", () => {
    const cfg = mkConfig();
    expect(() =>
      computePreflight(cfg, [LEAD_OAUTH, REVA_API, REVB_API]),
    ).not.toThrow();
  });

  test("rangeLowUsd and rangeHighUsd are still computed for priced adapters", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [LEAD_OAUTH, REVA_API, REVB_API]);
    // Priced adapters (reviewer_a, reviewer_b) contribute to ranges
    expect(r.rangeLowUsd).toBeGreaterThan(0);
    expect(r.rangeHighUsd).toBeGreaterThan(0);
  });
});

describe("preflight — API-key adapters unchanged", () => {
  test("all API-key adapters: no OAuth warning", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [LEAD_API, REVA_API, REVB_API]);
    const hasOAuthWarning = r.warnings.some((w) => /oauth/i.test(w));
    expect(hasOAuthWarning).toBe(false);
  });

  test("all API-key adapters: per-adapter usd is numeric", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [LEAD_API, REVA_API, REVB_API]);
    for (const [, entry] of Object.entries(r.perAdapter)) {
      expect(typeof entry.usd).toBe("number");
    }
  });
});
