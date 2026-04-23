// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_LEAD_MODEL,
  detectDegradedResolution,
  formatDegradedSummary,
  formatStatusDegradedLine,
} from "../../src/loop/degradation.ts";

describe("loop/degradation — detectDegradedResolution (SPEC §11)", () => {
  test("default models -> no degradation", () => {
    const res = detectDegradedResolution({
      lead: { adapter: "claude", model_id: DEFAULT_LEAD_MODEL },
      reviewer_a: { adapter: "codex", model_id: DEFAULT_CODEX_MODEL },
      reviewer_b: { adapter: "claude", model_id: DEFAULT_LEAD_MODEL },
      coupled_fallback: false,
    });
    expect(res.degraded).toBe(false);
    expect(res.items).toEqual([]);
  });

  test("lead fell back to sonnet -> flagged", () => {
    const res = detectDegradedResolution({
      lead: { adapter: "claude", model_id: "claude-sonnet-4-6" },
      reviewer_a: { adapter: "codex", model_id: DEFAULT_CODEX_MODEL },
      reviewer_b: { adapter: "claude", model_id: "claude-sonnet-4-6" },
      coupled_fallback: true,
    });
    expect(res.degraded).toBe(true);
    expect(res.items.some((i) => i.includes("lead"))).toBe(true);
    expect(res.items.some((i) => i.includes("coupled_fallback"))).toBe(true);
  });

  test("Codex fell back to gpt-5.3-codex (non-default) -> flagged", () => {
    const res = detectDegradedResolution({
      lead: { adapter: "claude", model_id: DEFAULT_LEAD_MODEL },
      reviewer_a: { adapter: "codex", model_id: "gpt-5.3-codex" },
      reviewer_b: { adapter: "claude", model_id: DEFAULT_LEAD_MODEL },
      coupled_fallback: false,
    });
    expect(res.degraded).toBe(true);
    expect(res.items.some((i) => i.includes("reviewer_a"))).toBe(true);
  });

  test("formatDegradedSummary prints SPEC §11 style line", () => {
    const text = formatDegradedSummary({
      degraded: true,
      items: [
        "lead fell back to claude-sonnet-4-6",
        "reviewer_a fell back to gpt-5.3-codex",
      ],
    });
    expect(text).toContain("degraded model resolution");
    expect(text).toContain("lead fell back to claude-sonnet-4-6");
    expect(text).toContain("reviewer_a fell back to gpt-5.3-codex");
  });

  test("formatStatusDegradedLine empty when no degradation", () => {
    const line = formatStatusDegradedLine({ degraded: false, items: [] });
    expect(line).toBe("");
  });
});
