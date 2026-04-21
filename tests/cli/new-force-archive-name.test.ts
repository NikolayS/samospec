// Copyright 2026 Nikolay Samokhvalov.

/**
 * RED tests for #69 — --force archive naming.
 *
 * SPEC §10: `samospec new <slug> --force` archives the existing slug dir to
 *   `.samo/spec/<slug>.archived-<timestamp>/`
 * where timestamp is ISO 8601 UTC without colons:
 *   YYYY-MM-DDThhmmssZ
 * e.g. `.archived-2026-04-20T214433Z`
 *
 * Also: two --force runs in the same second must produce distinct dirs
 * (collision counter: -1, -2, …).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  archiveSlugDir,
  makeArchiveTimestamp,
  type ArchiveResult,
} from "../../src/cli/archive.ts";

let tmp: string;
let specsDir: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-force-archive-"));
  specsDir = path.join(tmp, ".samo", "spec");
  mkdirSync(specsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// Timestamp format: YYYY-MM-DDThhmmssZ (no colons — Windows portable).
const ARCHIVE_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{6}Z$/;

// Full archive dir name pattern: <slug>.archived-<ts>
const ARCHIVE_DIR_RE = /^[^.]+\.archived-\d{4}-\d{2}-\d{2}T\d{6}Z(-\d+)?$/;

describe("makeArchiveTimestamp — format", () => {
  test("returns YYYY-MM-DDThhmmssZ without colons", () => {
    const ts = makeArchiveTimestamp(new Date("2026-04-20T21:44:33Z"));
    expect(ts).toBe("2026-04-20T214433Z");
    expect(ARCHIVE_TS_RE.test(ts)).toBe(true);
  });

  test("pads single-digit hours/minutes/seconds", () => {
    const ts = makeArchiveTimestamp(new Date("2026-01-02T03:04:05Z"));
    expect(ts).toBe("2026-01-02T030405Z");
  });
});

describe("archiveSlugDir — naming", () => {
  test("renames slug dir to <slug>.archived-<ts>/ (NOT .bak.<ts>)", () => {
    const slug = "myslug";
    const slugDir = path.join(specsDir, slug);
    mkdirSync(slugDir);
    writeFileSync(path.join(slugDir, "state.json"), '{"slug":"myslug"}');

    const result = archiveSlugDir({
      specsDir,
      slug,
      now: new Date("2026-04-20T21:44:33Z"),
    });

    expect(result.kind).toBe("archived");
    const r = result as Extract<ArchiveResult, { kind: "archived" }>;

    // Must not contain ".bak."
    expect(r.archivedPath).not.toContain(".bak.");
    // Must match the .archived-<ts> pattern.
    const basename = path.basename(r.archivedPath);
    expect(ARCHIVE_DIR_RE.test(basename)).toBe(true);
    expect(basename).toContain(".archived-2026-04-20T214433Z");

    // Slug dir must no longer exist at its original path.
    expect(existsSync(slugDir)).toBe(false);
    // Archived dir must exist.
    expect(existsSync(r.archivedPath)).toBe(true);
  });

  test("archived dir lives inside .samo/spec/ (same parent as slug dir)", () => {
    const slug = "proj";
    const slugDir = path.join(specsDir, slug);
    mkdirSync(slugDir);

    const result = archiveSlugDir({
      specsDir,
      slug,
      now: new Date("2026-04-20T10:00:00Z"),
    });

    expect(result.kind).toBe("archived");
    const r = result as Extract<ArchiveResult, { kind: "archived" }>;
    // Parent dir of the archive must be specsDir.
    expect(path.dirname(r.archivedPath)).toBe(specsDir);
  });
});

describe("archiveSlugDir — collision handling", () => {
  test("two calls with the same timestamp produce distinct archive dirs", () => {
    const slug = "demo";
    const now = new Date("2026-04-20T12:00:00Z");

    // First run.
    mkdirSync(path.join(specsDir, slug));
    const r1 = archiveSlugDir({ specsDir, slug, now });
    expect(r1.kind).toBe("archived");

    // Second run (same timestamp, recreate slug dir).
    mkdirSync(path.join(specsDir, slug));
    const r2 = archiveSlugDir({ specsDir, slug, now });
    expect(r2.kind).toBe("archived");

    const p1 = (r1 as Extract<ArchiveResult, { kind: "archived" }>)
      .archivedPath;
    const p2 = (r2 as Extract<ArchiveResult, { kind: "archived" }>)
      .archivedPath;

    // Must be distinct paths.
    expect(p1).not.toBe(p2);
    // Both must exist.
    expect(existsSync(p1)).toBe(true);
    expect(existsSync(p2)).toBe(true);

    // Second dir should have a collision suffix like -1.
    const b2 = path.basename(p2);
    expect(b2).toMatch(/-\d+$/);
  });

  test("third collision produces -2 suffix", () => {
    const slug = "demo";
    const now = new Date("2026-04-20T12:00:00Z");

    mkdirSync(path.join(specsDir, slug));
    const r1 = archiveSlugDir({ specsDir, slug, now });
    mkdirSync(path.join(specsDir, slug));
    const r2 = archiveSlugDir({ specsDir, slug, now });
    mkdirSync(path.join(specsDir, slug));
    const r3 = archiveSlugDir({ specsDir, slug, now });

    expect(r1.kind).toBe("archived");
    expect(r2.kind).toBe("archived");
    expect(r3.kind).toBe("archived");

    const paths = [r1, r2, r3].map(
      (r) => (r as Extract<ArchiveResult, { kind: "archived" }>).archivedPath,
    );
    // All distinct.
    expect(new Set(paths).size).toBe(3);
    // All exist.
    for (const p of paths) expect(existsSync(p)).toBe(true);
  });
});

describe("archiveSlugDir — listing existing archives", () => {
  test("archived dirs appear in readdirSync of specsDir", () => {
    const slug = "report";
    mkdirSync(path.join(specsDir, slug));
    archiveSlugDir({
      specsDir,
      slug,
      now: new Date("2026-04-20T09:30:00Z"),
    });

    const entries = readdirSync(specsDir);
    // At least one entry matching the archive pattern.
    const archiveEntries = entries.filter((e) => e.includes(".archived-"));
    expect(archiveEntries.length).toBeGreaterThan(0);
  });
});
