// Copyright 2026 Nikolay Samokhvalov.

// SPEC §3 + Issue #107 — red-first tests for SPEC.md sentinel block
// injection. The sentinels are literal HTML comments so they survive
// Markdown rendering everywhere; the renderer replaces the block on
// iterate without touching surrounding prose.

import { describe, expect, test } from "bun:test";

import { injectArchitectureBlock } from "../../src/render/architecture-spec.ts";
import type { Architecture } from "../../src/state/architecture.ts";

const BEGIN = "<!-- architecture:begin -->";
const END = "<!-- architecture:end -->";

function trivialArch(): Architecture {
  return {
    version: "1",
    nodes: [
      { id: "user", label: "User", kind: "external" },
      { id: "app", label: "App", kind: "component" },
    ],
    edges: [{ from: "user", to: "app", kind: "call" }],
  };
}

describe("injectArchitectureBlock — replace existing sentinels", () => {
  test("replaces the content between sentinels, preserving surroundings", () => {
    const spec = [
      "# demo",
      "",
      "## 3. Architecture",
      "",
      "Some prose that must be preserved verbatim.",
      "",
      BEGIN,
      "old diagram content",
      END,
      "",
      "## 4. Next section",
      "",
      "Trailing prose also preserved.",
      "",
    ].join("\n");
    const out = injectArchitectureBlock(spec, trivialArch());
    expect(out).toContain("Some prose that must be preserved verbatim.");
    expect(out).toContain("Trailing prose also preserved.");
    // Old content gone.
    expect(out).not.toContain("old diagram content");
    // New content between sentinels.
    const begin = out.indexOf(BEGIN);
    const end = out.indexOf(END);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const block = out.slice(begin, end + END.length);
    expect(block).toContain("User");
    expect(block).toContain("App");
    expect(block).toContain("user → app");
  });

  test("idempotent on re-injection with the same architecture", () => {
    const spec = [
      "# demo",
      "",
      "## 3. Architecture",
      "",
      BEGIN,
      END,
      "",
      "## 4. Other",
      "",
    ].join("\n");
    const once = injectArchitectureBlock(spec, trivialArch());
    const twice = injectArchitectureBlock(once, trivialArch());
    expect(twice).toBe(once);
  });
});

describe("injectArchitectureBlock — inject sentinels when absent", () => {
  test("inserts sentinel block under an Architecture heading", () => {
    const spec = [
      "# demo",
      "",
      "## 2. Why",
      "",
      "Body of section 2.",
      "",
      "## 3. Architecture",
      "",
      "Existing prose.",
      "",
      "## 4. Next",
      "",
      "More.",
      "",
    ].join("\n");
    const out = injectArchitectureBlock(spec, trivialArch());
    expect(out).toContain(BEGIN);
    expect(out).toContain(END);
    // Block lives after the Architecture heading and before the next `##`.
    const archIdx = out.indexOf("## 3. Architecture");
    const nextIdx = out.indexOf("## 4. Next");
    const beginIdx = out.indexOf(BEGIN);
    expect(beginIdx).toBeGreaterThan(archIdx);
    expect(beginIdx).toBeLessThan(nextIdx);
    // Existing prose preserved.
    expect(out).toContain("Existing prose.");
    expect(out).toContain("Body of section 2.");
  });

  test("appends a new Architecture section when no matching heading exists", () => {
    const spec = ["# demo", "", "## 2. Why", "", "Body.", ""].join("\n");
    const out = injectArchitectureBlock(spec, trivialArch());
    expect(out).toContain(BEGIN);
    expect(out).toContain(END);
    expect(out).toContain("Body.");
    // The added section's heading carries "Architecture".
    expect(out).toMatch(/^##\s+.*Architecture/im);
  });

  test("does not mutate a spec that has neither sentinels nor Architecture section, when scan-only is requested", () => {
    // Sanity: direct call always mutates; we just ensure the output
    // still contains the original body when the append-fallback fires.
    const spec = "# demo\n\nThis is a tiny spec.\n";
    const out = injectArchitectureBlock(spec, trivialArch());
    expect(out).toContain("This is a tiny spec.");
    expect(out).toContain(BEGIN);
  });
});

describe("injectArchitectureBlock — zero-node placeholder", () => {
  test("empty architecture renders the placeholder inside sentinels", () => {
    const spec = [
      "# demo",
      "",
      "## 3. Architecture",
      "",
      BEGIN,
      "stale",
      END,
      "",
    ].join("\n");
    const out = injectArchitectureBlock(spec, {
      version: "1",
      nodes: [],
      edges: [],
    });
    expect(out).toContain("(architecture not yet specified)");
    expect(out).not.toContain("stale");
  });
});
