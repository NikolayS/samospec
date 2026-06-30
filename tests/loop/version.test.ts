// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import {
  bumpMinor,
  compareSemver,
  formatChangelogEntry,
  formatVersionLabel,
  parsePublishedLabel,
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

describe("loop/version — parsePublishedLabel", () => {
  test("expands a short vX.Y label to the X.Y.0 triple", () => {
    expect(parsePublishedLabel("v0.2")).toBe("0.2.0");
    expect(parsePublishedLabel("v1.10")).toBe("1.10.0");
  });
  test("keeps an explicit patch in a vX.Y.Z label", () => {
    expect(parsePublishedLabel("v0.2.3")).toBe("0.2.3");
  });
  test("tolerates a missing leading v", () => {
    expect(parsePublishedLabel("0.4")).toBe("0.4.0");
  });
  test("returns null on a malformed label", () => {
    expect(parsePublishedLabel("not-a-version")).toBeNull();
    expect(parsePublishedLabel("v1")).toBeNull();
  });
});

describe("loop/version — compareSemver", () => {
  test("orders by major, then minor, then patch", () => {
    expect(compareSemver("0.2.0", "0.1.0")).toBeGreaterThan(0);
    expect(compareSemver("0.1.0", "0.2.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareSemver("0.2.1", "0.2.0")).toBeGreaterThan(0);
  });
  test("returns 0 for equal versions", () => {
    expect(compareSemver("0.2.0", "0.2.0")).toBe(0);
  });
  test("compares numerically, not lexically (v0.10 > v0.9)", () => {
    expect(compareSemver("0.10.0", "0.9.0")).toBeGreaterThan(0);
  });
  test("throws on a malformed input", () => {
    expect(() => compareSemver("0.2", "0.1.0")).toThrow();
  });
});
