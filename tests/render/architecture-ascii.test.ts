// Copyright 2026 Nikolay Samokhvalov.

// SPEC §3 + Issue #107 — red-first tests for the architecture ASCII
// renderer. Every fixture gets pinned against its rendered output; the
// hard-80 / soft-40 invariants are asserted separately because the
// oversized fixture is allowed to exceed the soft cap only after it's
// been collapsed through group-fold logic.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { renderArchitectureAscii } from "../../src/render/architecture-ascii.ts";
import {
  parseArchitecture,
  type Architecture,
} from "../../src/state/architecture.ts";

const FIXTURE_DIR = path.resolve(
  import.meta.dir,
  "..",
  "fixtures",
  "architecture",
);

function loadFixture(name: string): Architecture {
  const raw = JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, name), "utf8"),
  ) as unknown;
  return parseArchitecture(raw);
}

function lineWidths(s: string): number[] {
  // Unicode box-drawing characters are single-column for visual width;
  // `.length` counts UTF-16 code units which coincide with column count
  // for all characters in our renderer's output.
  return s.split("\n").map((l) => l.length);
}

describe("renderArchitectureAscii — zero-node placeholder", () => {
  test("empty schema renders the single-line placeholder", () => {
    const out = renderArchitectureAscii(loadFixture("zero-nodes.json"));
    expect(out).toBe("(architecture not yet specified)");
  });
});

describe("renderArchitectureAscii — trivial schema", () => {
  test("renders each node as a labeled box + the single edge", () => {
    const out = renderArchitectureAscii(loadFixture("trivial.json"));
    // Nodes appear in schema order.
    const userIdx = out.indexOf("User");
    const appIdx = out.indexOf("App");
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(appIdx).toBeGreaterThan(userIdx);
    // Box-drawing characters are used for the node box frame.
    expect(out).toMatch(/┌─+┐/u);
    expect(out).toMatch(/└─+┘/u);
    // Edge is rendered below the boxes.
    expect(out).toContain("user → app");
  });

  test("every rendered line is <= 80 columns", () => {
    const out = renderArchitectureAscii(loadFixture("trivial.json"));
    for (const w of lineWidths(out)) {
      expect(w).toBeLessThanOrEqual(80);
    }
  });
});

describe("renderArchitectureAscii — grouped schema", () => {
  test("lists the group and its members when under the soft cap", () => {
    const out = renderArchitectureAscii(loadFixture("grouped.json"));
    expect(out).toContain("Lead adapter");
    expect(out).toContain("Claude adapter");
    expect(out).toContain("Codex adapter");
    expect(out).toContain("Gemini adapter");
    // Group heading present.
    expect(out).toMatch(/adapters.*claude.*codex.*gemini/is);
  });

  test("edges to a group id render with the group label", () => {
    const out = renderArchitectureAscii(loadFixture("grouped.json"));
    expect(out).toContain("lead → adapters");
  });
});

describe("renderArchitectureAscii — oversized schema", () => {
  test("collapses groups under the soft cap when full render would blow ~40 lines", () => {
    const out = renderArchitectureAscii(loadFixture("oversized.json"));
    // The un-collapsed oversized fixture has 20 nodes × 3 lines/box =
    // 60+ lines. The collapsed form must NOT individually render every
    // adapter or datastore member.
    expect(out).not.toContain("adapter 01");
    expect(out).not.toContain("adapter 12");
    expect(out).not.toContain("datastore 01");
    // But the collapsed group pill IS present, carrying the member count.
    expect(out).toContain("[12 adapters]");
    expect(out).toContain("[6 datastores]");
  });

  test("oversized schema stays within the 80-col hard cap", () => {
    const out = renderArchitectureAscii(loadFixture("oversized.json"));
    for (const w of lineWidths(out)) {
      expect(w).toBeLessThanOrEqual(80);
    }
  });
});

describe("renderArchitectureAscii — label truncation", () => {
  test("labels that would blow 80 cols are truncated with ellipsis", () => {
    const longLabel = "x".repeat(200);
    const out = renderArchitectureAscii({
      version: "1",
      nodes: [{ id: "n", label: longLabel, kind: "component" }],
      edges: [],
    });
    for (const w of lineWidths(out)) {
      expect(w).toBeLessThanOrEqual(80);
    }
    expect(out).toContain("…");
  });
});

describe("renderArchitectureAscii — determinism", () => {
  test("two calls on the same schema produce byte-identical output", () => {
    const a = renderArchitectureAscii(loadFixture("grouped.json"));
    const b = renderArchitectureAscii(loadFixture("grouped.json"));
    expect(a).toBe(b);
  });
});
