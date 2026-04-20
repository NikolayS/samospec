// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_CONTEXT_BUDGETS,
  estimateTokens,
  fitFilesToBudget,
  type ContextBudgets,
} from "../../src/context/budget.ts";

describe("context/budget — per-phase defaults (SPEC §7)", () => {
  test("DEFAULT_CONTEXT_BUDGETS has the SPEC numbers", () => {
    expect(DEFAULT_CONTEXT_BUDGETS.interview).toBe(5_000);
    expect(DEFAULT_CONTEXT_BUDGETS.draft).toBe(30_000);
    expect(DEFAULT_CONTEXT_BUDGETS.revision).toBe(20_000);
  });

  test("ContextBudgets type accepts overrides", () => {
    const custom: ContextBudgets = {
      interview: 6_000,
      draft: 40_000,
      revision: 25_000,
    };
    expect(custom.interview).toBe(6_000);
  });
});

describe("context/budget — estimateTokens", () => {
  test("roughly 4 chars per token (SPEC §7 heuristic)", () => {
    // 4000 chars of ASCII -> ~1000 tokens.
    expect(estimateTokens("x".repeat(4000))).toBe(1000);
    expect(estimateTokens("")).toBe(0);
    // Single char rounds up to 1.
    expect(estimateTokens("a")).toBe(1);
  });
});

describe("context/budget — fitFilesToBudget", () => {
  test("includes files until budget exhausted; rest marked excluded", () => {
    const files = [
      { path: "a.md", content: "x".repeat(4000) }, // ~1000 tokens
      { path: "b.md", content: "y".repeat(4000) }, // ~1000 tokens
      { path: "c.md", content: "z".repeat(4000) }, // ~1000 tokens
    ];
    const plan = fitFilesToBudget({
      files,
      budgetTokens: 2500, // two fit; third excluded
    });
    expect(plan.included.map((f) => f.path)).toEqual(["a.md", "b.md"]);
    expect(plan.excluded.map((f) => f.path)).toEqual(["c.md"]);
    expect(plan.tokensUsed).toBe(2000);
    expect(plan.tokensBudget).toBe(2500);
  });

  test("a single oversized file that alone exceeds budget is excluded", () => {
    const files = [
      { path: "huge.md", content: "x".repeat(40_000) }, // ~10k tokens
      { path: "small.md", content: "x".repeat(400) }, // ~100 tokens
    ];
    const plan = fitFilesToBudget({
      files,
      budgetTokens: 500,
    });
    expect(plan.included.map((f) => f.path)).toEqual(["small.md"]);
    expect(plan.excluded.map((f) => f.path)).toEqual(["huge.md"]);
  });

  test("zero-budget excludes everything", () => {
    const files = [{ path: "a.md", content: "hi" }];
    const plan = fitFilesToBudget({ files, budgetTokens: 0 });
    expect(plan.included).toEqual([]);
    expect(plan.excluded.map((f) => f.path)).toEqual(["a.md"]);
  });
});
