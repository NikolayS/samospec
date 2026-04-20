// Copyright 2026 Nikolay Samokhvalov.

// Tests for #60: samospec new / resume must not contain stale
// "Sprint 3" or "--no-push default active" scaffolding text.
// Uses direct source inspection (most reliable).

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";

// Read CLI source files for stale-text checks.
const NEW_SRC = readFileSync(
  new URL("../../src/cli/new.ts", import.meta.url).pathname,
  "utf8",
);
const RESUME_SRC = readFileSync(
  new URL("../../src/cli/resume.ts", import.meta.url).pathname,
  "utf8",
);

describe("samospec new/resume source — no stale sprint text (#60)", () => {
  // Source-level checks: the literal stale strings must not appear in
  // the user-visible notice paths of new.ts or resume.ts.

  test("new.ts source does not contain 'review loop lands in Sprint'", () => {
    expect(NEW_SRC).not.toContain("review loop lands in Sprint");
  });

  test("new.ts source does not contain '--no-push default active'", () => {
    expect(NEW_SRC).not.toContain("--no-push default active");
  });

  test("new.ts source does not contain 'push consent gate ships in Sprint'", () => {
    expect(NEW_SRC).not.toContain("push consent gate ships in Sprint");
  });

  test("resume.ts source does not contain 'ready for review loop (Sprint 3)'", () => {
    expect(RESUME_SRC).not.toContain("ready for review loop (Sprint 3)");
  });

  test("new.ts source does not contain stale Sprint-3 notice strings", () => {
    // Check the user-visible string literals specifically.
    expect(NEW_SRC).not.toContain("review loop lands in Sprint 3");
    expect(NEW_SRC).not.toContain(
      "--no-push default active; push consent gate ships in Sprint 3",
    );
  });
});

describe("samospec new source — next-step hint uses iterate/resume (#60)", () => {
  test("new.ts source contains 'samospec iterate' in next-step notice", () => {
    // The notice() call that replaced the stale Sprint-3 hint must
    // reference 'samospec iterate' so users know how to continue.
    expect(NEW_SRC).toContain("samospec iterate");
  });

  test("new.ts source contains 'samospec resume' in next-step notice", () => {
    expect(NEW_SRC).toContain("samospec resume");
  });

  test("resume.ts source contains 'samospec iterate' in next-step notice", () => {
    expect(RESUME_SRC).toContain("samospec iterate");
  });
});
