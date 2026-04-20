// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import {
  LARGE_FILE_LINE_THRESHOLD,
  truncateContent,
} from "../../src/context/truncate.ts";

function makeMarkdownFixture(lineCount: number): string {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    // Sprinkle top-level and sub-headers at known positions so we can
    // verify the "keep header + 50 following" rule.
    if (i === 100) lines.push("# Top-level header A");
    else if (i === 500) lines.push("## Sub-header B");
    else if (i === 1500) lines.push("# Late header C");
    else lines.push(`prose line ${String(i)}`);
  }
  return lines.join("\n");
}

function makeCodeFixture(lineCount: number): string {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push(`// line ${String(i)}`);
  }
  return lines.join("\n");
}

describe("context/truncate — threshold (SPEC §7)", () => {
  test("LARGE_FILE_LINE_THRESHOLD is 1000", () => {
    expect(LARGE_FILE_LINE_THRESHOLD).toBe(1000);
  });

  test("files at/below the threshold pass through untouched", () => {
    const content = "hello\nworld\n";
    const out = truncateContent({
      path: "README.md",
      content,
      kind: "markdown",
      recentHunks: [],
    });
    expect(out.truncated).toBe(false);
    expect(out.content).toBe(content);
  });
});

describe("context/truncate — markdown headers (SPEC §7)", () => {
  test("2000-line markdown keeps lines under each header + 50 following", () => {
    const content = makeMarkdownFixture(2000);
    const out = truncateContent({
      path: "docs/big.md",
      content,
      kind: "markdown",
      recentHunks: [],
    });
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBeLessThan(content.length);
    // Headers are preserved verbatim in the output.
    expect(out.content).toContain("# Top-level header A");
    expect(out.content).toContain("## Sub-header B");
    expect(out.content).toContain("# Late header C");
    // The lines immediately following a header are preserved.
    expect(out.content).toContain("prose line 101"); // within the +50 window of line 100
    expect(out.content).toContain("prose line 501"); // within the +50 window of line 500
    expect(out.content).toContain("prose line 1501");
    // A far-from-header line should be dropped.
    expect(out.content).not.toContain("prose line 300");
    expect(out.content).not.toContain("prose line 800");
  });
});

describe("context/truncate — code head/tail + recent hunks (SPEC §7)", () => {
  test("keeps first 100 + last 100 lines for code, plus recent-blame hunks", () => {
    const content = makeCodeFixture(2000);
    const out = truncateContent({
      path: "src/big.ts",
      content,
      kind: "code",
      // simulate a git-blame hunk discovered for lines 900-905
      recentHunks: [{ startLine: 900, endLine: 905 }],
    });
    expect(out.truncated).toBe(true);
    expect(out.content).toContain("// line 0");
    expect(out.content).toContain("// line 99"); // within first 100
    expect(out.content).toContain("// line 1999"); // within last 100
    expect(out.content).toContain("// line 1900"); // within last 100
    expect(out.content).toContain("// line 900"); // recent hunk
    expect(out.content).toContain("// line 905"); // recent hunk end
    // A line in the middle not covered by any rule is dropped.
    expect(out.content).not.toContain("// line 500");
  });
});

describe("context/truncate — other text (SPEC §7)", () => {
  test("keeps head 100 + tail 100 for 'text' kind", () => {
    const content = makeCodeFixture(2000);
    const out = truncateContent({
      path: "notes.txt",
      content,
      kind: "text",
      recentHunks: [],
    });
    expect(out.truncated).toBe(true);
    expect(out.content).toContain("// line 0");
    expect(out.content).toContain("// line 99");
    expect(out.content).toContain("// line 1999");
    expect(out.content).toContain("// line 1900");
    expect(out.content).not.toContain("// line 1000");
  });
});
