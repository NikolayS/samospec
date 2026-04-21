// Copyright 2026 Nikolay Samokhvalov.

// RED tests for Issue #70: preflight must show "unknown — OAuth" for
// Codex reviewer_a when running under ChatGPT OAuth (subscription_auth:
// true), NOT a dollar estimate.
//
// The bug (UX report #62 item 6):
//   reviewer_a: ~75K tokens, $1.88    ← WRONG (should be OAuth label)
//
// Fix: when reviewer_a's auth_status returns subscription_auth: true,
// computePreflight must treat it the same as lead/reviewer_b under OAuth.

import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../../src/cli/init.ts";
import {
  computePreflight,
  formatPreflight,
  type PreflightAdapter,
  type PreflightConfig,
} from "../../src/policy/preflight.ts";

function mkConfig(): PreflightConfig {
  return {
    adapters: {
      lead: { ...DEFAULT_CONFIG.adapters.lead },
      reviewer_a: { ...DEFAULT_CONFIG.adapters.reviewer_a },
      reviewer_b: { ...DEFAULT_CONFIG.adapters.reviewer_b },
    },
    budget: { ...DEFAULT_CONFIG.budget },
    calibration: null,
  };
}

function mkAdapter(
  id: string,
  vendor: string,
  subscription_auth: boolean,
  role: "lead" | "reviewer_a" | "reviewer_b",
): PreflightAdapter {
  return { id, vendor, role, subscription_auth };
}

// Canonical adapters for a ChatGPT-OAuth scenario:
// lead uses Claude subscription (OAuth), reviewer_a uses Codex ChatGPT-
// OAuth, reviewer_b uses Claude API key.
const LEAD_OAUTH = mkAdapter("lead", "claude", true, "lead");
const REVA_CODEX_OAUTH = mkAdapter("reviewer_a", "codex", true, "reviewer_a");
const REVB_CLAUDE_APIKEY = mkAdapter(
  "reviewer_b",
  "claude",
  false,
  "reviewer_b",
);

// Baseline: all API-key adapters (no OAuth anywhere).
const LEAD_APIKEY = mkAdapter("lead", "claude", false, "lead");
const REVA_APIKEY = mkAdapter("reviewer_a", "codex", false, "reviewer_a");
const REVB_APIKEY = mkAdapter("reviewer_b", "claude", false, "reviewer_b");

describe("#70 — preflight: reviewer_a Codex under ChatGPT OAuth → OAuth label", () => {
  test(
    "reviewer_a with subscription_auth: true shows " +
      "'unknown — OAuth (no per-token cost visibility)'",
    () => {
      const cfg = mkConfig();
      const r = computePreflight(cfg, [
        LEAD_OAUTH,
        REVA_CODEX_OAUTH,
        REVB_CLAUDE_APIKEY,
      ]);
      const perA = r.perAdapter["reviewer_a"];
      expect(perA).toBeDefined();
      expect(perA?.usd).toBe("unknown — OAuth (no per-token cost visibility)");
    },
  );

  test("reviewer_a OAuth: likelyUsd excludes reviewer_a cost", () => {
    const cfgAll = mkConfig();
    // Baseline: all API keys → likelyUsd includes reviewer_a.
    const rAll = computePreflight(cfgAll, [
      LEAD_APIKEY,
      REVA_APIKEY,
      REVB_APIKEY,
    ]);
    // OAuth scenario: reviewer_a excluded from likelyUsd.
    const rOAuth = computePreflight(mkConfig(), [
      LEAD_APIKEY,
      REVA_CODEX_OAUTH,
      REVB_APIKEY,
    ]);
    // With OAuth reviewer_a, the likelyUsd should be less than all-API-key.
    expect(rOAuth.likelyUsd).toBeLessThan(rAll.likelyUsd);
  });

  test("pretty-printer for OAuth reviewer_a says 'OAuth' (not dollar amount)", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [
      LEAD_OAUTH,
      REVA_CODEX_OAUTH,
      REVB_CLAUDE_APIKEY,
    ]);
    const text = formatPreflight(r);

    // Must contain OAuth label in per-adapter section.
    expect(text).toContain("OAuth");
    // Must NOT show a dollar amount for reviewer_a when OAuth.
    // The dollar-sign should appear only in the summary line, not per-adapter.
    const perAdapterSection = text
      .split("per-adapter:")[1]
      ?.split("warnings:")[0];
    expect(perAdapterSection).toBeDefined();
    // The per-adapter section for reviewer_a must say "OAuth", not "$N.NN".
    const reviewerALine = perAdapterSection
      ?.split("\n")
      .find((l) => l.includes("reviewer_a"));
    expect(reviewerALine).toBeDefined();
    expect(reviewerALine).toContain("OAuth");
    expect(reviewerALine).not.toMatch(/\$\d+\.\d+/);
  });

  test("warnings include mention of OAuth when reviewer_a is OAuth", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [
      LEAD_APIKEY,
      REVA_CODEX_OAUTH,
      REVB_APIKEY,
    ]);
    const hasOAuthWarn = r.warnings.some((w) => /oauth/i.test(w));
    expect(hasOAuthWarn).toBe(true);
  });

  test("full OAuth scenario (all three adapters): likelyUsd is 0", () => {
    const cfg = mkConfig();
    const allOAuth = [
      mkAdapter("lead", "claude", true, "lead"),
      mkAdapter("reviewer_a", "codex", true, "reviewer_a"),
      mkAdapter("reviewer_b", "claude", true, "reviewer_b"),
    ];
    const r = computePreflight(cfg, allOAuth);
    expect(r.likelyUsd).toBe(0);
    for (const [, entry] of Object.entries(r.perAdapter)) {
      expect(entry.usd).toBe("unknown — OAuth (no per-token cost visibility)");
    }
  });
});

describe("#70 — preflight: API-key reviewer_a unchanged", () => {
  test("reviewer_a with subscription_auth: false shows dollar estimate", () => {
    const cfg = mkConfig();
    const r = computePreflight(cfg, [LEAD_APIKEY, REVA_APIKEY, REVB_APIKEY]);
    const perA = r.perAdapter["reviewer_a"];
    expect(perA).toBeDefined();
    expect(typeof perA?.usd).toBe("number");
  });
});
