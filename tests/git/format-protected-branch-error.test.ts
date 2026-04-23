// Copyright 2026 Nikolay Samokhvalov.

// Issue #142: unit tests for `formatProtectedBranchError(branch, slug, source)`.
//
// The helper produces the canonical post-#126 / #132 refusal string
// emitted when `samospec iterate` / `samospec new` / `samospec resume`
// would otherwise commit on a protected branch. All three call sites
// share this exact wording.

import { describe, expect, test } from "bun:test";

import { formatProtectedBranchError } from "../../src/git/protected.ts";

describe("formatProtectedBranchError — canonical post-#126 refusal string", () => {
  test("names the source and recommends the samospec/<slug> branch", () => {
    const out = formatProtectedBranchError(
      "main",
      "myfeature",
      "built-in default",
    );
    expect(out).toBe(
      "samospec: refusing to commit on protected branch 'main' " +
        "(built-in default). Check out samospec/myfeature and re-run.",
    );
  });

  test("accepts 'config' as the source label for user-configured protection", () => {
    const out = formatProtectedBranchError("staging", "refunds", "config");
    expect(out).toBe(
      "samospec: refusing to commit on protected branch 'staging' " +
        "(config). Check out samospec/refunds and re-run.",
    );
  });

  test("interpolates slug literally (supports hyphens, digits, slashes)", () => {
    const out = formatProtectedBranchError(
      "trunk",
      "checkout-flow-2",
      "built-in default",
    );
    expect(out).toContain("samospec/checkout-flow-2");
    expect(out).toContain("'trunk' (built-in default)");
  });

  test("includes the 'samospec:' prefix so it matches other samospec error lines", () => {
    const out = formatProtectedBranchError("main", "x", "built-in default");
    expect(out.startsWith("samospec: ")).toBe(true);
  });

  test("preserves the canonical ' (built-in default)' substring for test matchers", () => {
    // The existing iterate / new e2e tests assert on the substring
    // 'built-in default' + 'samospec/'. Guard that contract here so
    // any refactor that changes the wording fails this helper test
    // first, before tripping the e2e tests.
    const out = formatProtectedBranchError(
      "master",
      "demo",
      "built-in default",
    );
    expect(out).toContain("built-in default");
    expect(out).toContain("samospec/");
  });
});
