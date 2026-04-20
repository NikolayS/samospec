// Copyright 2026 Nikolay Samokhvalov.

// SPEC §5 Phase 5 + §9 — heuristic `TLDR.md` renderer.
// Red-first contract:
//   1. goal: first `## Goal` paragraph OR first paragraph after title.
//   2. scope: bullet list of `##` headings (excluding the Goal heading
//      so we don't duplicate the section above).
//   3. next-action: literal "resume with `samospec resume <slug>`" line.
//   4. Return is non-empty even when the spec is a minimal stub.

import { describe, expect, test } from "bun:test";

import { renderTldr } from "../../src/render/tldr.ts";

describe("renderTldr — goal extraction", () => {
  test("extracts paragraph under `## Goal` heading", () => {
    const spec =
      "# refunds spec\n\n" +
      "## Goal\n\nEnable marketplace-X sellers to issue partial refunds " +
      "without manual work.\n\n" +
      "## Scope\n\n- API\n- UI\n";
    const out = renderTldr(spec, { slug: "refunds" });
    expect(out).toContain("Enable marketplace-X sellers");
  });

  test("falls back to first paragraph after title when no Goal heading", () => {
    const spec =
      "# refunds spec\n\n" +
      "This document covers the refunds flow end-to-end.\n\n" +
      "## Scope\n\n- one thing\n";
    const out = renderTldr(spec, { slug: "refunds" });
    expect(out).toContain("This document covers the refunds flow");
  });

  test("tolerates a spec with no paragraph text after the title", () => {
    const spec = "# refunds spec\n\n## Scope\n\n- one thing\n";
    const out = renderTldr(spec, { slug: "refunds" });
    // Should still render without throwing; goal may be a placeholder.
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("renderTldr — scope summary", () => {
  test("lists all `##` headings as `- ` bullets (excluding Goal)", () => {
    const spec =
      "# refunds spec\n\n" +
      "## Goal\n\nOneliner.\n\n" +
      "## Users\n\nx\n\n" +
      "## Scope\n\ny\n\n" +
      "## Non-goals\n\nz\n";
    const out = renderTldr(spec, { slug: "refunds" });
    expect(out).toContain("- Users");
    expect(out).toContain("- Scope");
    expect(out).toContain("- Non-goals");
    // Goal is captured in the goal section, don't duplicate it.
    expect(out.split("- Goal").length - 1).toBe(0);
  });

  test("ignores `#` title and `###` subsections", () => {
    const spec =
      "# refunds spec\n\n" +
      "## Goal\n\nHi.\n\n" +
      "## Scope\n\n### sub\n\n- x\n";
    const out = renderTldr(spec, { slug: "refunds" });
    expect(out).toContain("- Scope");
    expect(out).not.toContain("- refunds spec");
    expect(out).not.toContain("- sub");
  });
});

describe("renderTldr — next action", () => {
  test("includes the literal resume hint referencing the slug", () => {
    const spec = "# demo\n\n## Goal\n\nx.\n";
    const out = renderTldr(spec, { slug: "demo" });
    expect(out).toContain("samospec resume demo");
  });
});

describe("renderTldr — structure", () => {
  test("begins with a `# TL;DR` heading", () => {
    const spec = "# demo\n\n## Goal\n\nx.\n";
    const out = renderTldr(spec, { slug: "demo" });
    expect(out.startsWith("# TL;DR")).toBe(true);
  });

  test("ends with a trailing newline so file writes are POSIX-clean", () => {
    const spec = "# demo\n\n## Goal\n\nhello.\n";
    const out = renderTldr(spec, { slug: "demo" });
    expect(out.endsWith("\n")).toBe(true);
  });
});
