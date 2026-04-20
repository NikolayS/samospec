// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import {
  bumpMinor,
  formatChangelogEntry,
  formatVersionLabel,
} from "../../src/loop/version.ts";

describe("loop/version — version bump", () => {
  test("v0.1 -> v0.2", () => {
    expect(bumpMinor("0.1.0")).toBe("0.2.0");
  });
  test("v0.9 -> v0.10", () => {
    expect(bumpMinor("0.9.0")).toBe("0.10.0");
  });
  test("v1.2.3 -> v1.3.0 (patch is reset)", () => {
    expect(bumpMinor("1.2.3")).toBe("1.3.0");
  });
  test("invalid input throws", () => {
    expect(() => bumpMinor("not-a-version")).toThrow();
  });
});

describe("loop/version — formatVersionLabel", () => {
  test("emits short vX.Y label (SPEC §5 convention)", () => {
    expect(formatVersionLabel("0.2.0")).toBe("v0.2");
    expect(formatVersionLabel("0.10.0")).toBe("v0.10");
    expect(formatVersionLabel("1.3.0")).toBe("v1.3");
  });
  test("keeps patch when non-zero", () => {
    expect(formatVersionLabel("0.2.1")).toBe("v0.2.1");
  });
});

describe("loop/version — formatChangelogEntry", () => {
  test("builds a standard entry for a successful round", () => {
    const entry = formatChangelogEntry({
      version: "0.2.0",
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      accepted: 4,
      rejected: 1,
      deferred: 2,
    });
    expect(entry).toContain("## v0.2 — 2026-04-19T12:00:00Z");
    expect(entry).toContain("- Round 1 reviews applied");
    expect(entry).toContain("accepted: 4");
    expect(entry).toContain("rejected: 1");
    expect(entry).toContain("deferred: 2");
  });

  test("records degraded resolution hint when supplied", () => {
    const entry = formatChangelogEntry({
      version: "0.3.0",
      now: "2026-04-19T12:00:00Z",
      roundNumber: 2,
      accepted: 1,
      rejected: 0,
      deferred: 0,
      degradedResolution: "lead fell back to claude-sonnet-4-6",
    });
    expect(entry).toContain("lead fell back to claude-sonnet-4-6");
  });
});
