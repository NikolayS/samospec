// Copyright 2026 Nikolay Samokhvalov.

// `--idea-file` — read the idea from a file (AI/CI ergonomics).
//
// Pins:
//   - loadIdeaFile() reads a file, trims surrounding whitespace, and
//     preserves internal formatting; empty / unreadable files are clear
//     tagged-union errors (tested in isolation, mirroring loadAnswersFile).
//   - parseNewArgs rejects --idea + --idea-file at parse time (exit 1)
//     BEFORE any adapter is constructed.
//   - --idea-file with a missing path surfaces the loader error.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadIdeaFile } from "../../src/cli/non-interactive.ts";
import { runCli } from "../../src/cli.ts";

describe("loadIdeaFile", () => {
  test("reads file contents, trims surrounding whitespace", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "samospec-idea-"));
    try {
      const p = path.join(dir, "idea.md");
      writeFileSync(p, "\n\n  An umbrella CLI for the samo tools.\n\n");
      const r = loadIdeaFile(p);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.idea).toBe("An umbrella CLI for the samo tools.");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves internal multi-paragraph / markdown formatting", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "samospec-idea-"));
    try {
      const p = path.join(dir, "idea.md");
      const body = "# Title\n\n- one\n- two\n\nFinal paragraph.";
      writeFileSync(p, `\n${body}\n`);
      const r = loadIdeaFile(p);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.idea).toBe(body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty / whitespace-only file is an error", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "samospec-idea-"));
    try {
      const p = path.join(dir, "blank.md");
      writeFileSync(p, "   \n\t\n");
      const r = loadIdeaFile(p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("--idea-file is empty");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unreadable / missing file is an error", () => {
    const r = loadIdeaFile("/no/such/idea-file/here.md");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--idea-file could not be read");
  });
});

describe("samospec new --idea-file — flag coherence", () => {
  test("--idea and --idea-file are mutually exclusive (parse-time, exit 1)", async () => {
    const res = await runCli([
      "new",
      "demo",
      "--idea",
      "x",
      "--idea-file",
      "y.md",
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(
      "--idea and --idea-file are mutually exclusive",
    );
  });

  test("--idea-file with a missing path surfaces the loader error", async () => {
    const res = await runCli([
      "new",
      "demo",
      "--accept-persona",
      "--idea-file",
      "/no/such/file.md",
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--idea-file could not be read");
  });
});
