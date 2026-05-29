// Copyright 2026 Nikolay Samokhvalov.

// FIX 5 — non-TTY dirty-guard robustness.
//
// Between rounds, `samospec iterate` re-checks `git status` under the
// spec dir. The post-commit `state.json` head_sha rewrite and freshly
// written `reviews/rNN/` artifacts leave the tree "dirty" with samospec's
// OWN churn — not a user edit. In non-TTY mode that used to dead-end on
// "Pass --on-dirty". `allFilesAreSamospecManaged` lets the resolver tell
// samospec's own artifacts apart from genuine user edits so it can
// auto-incorporate the former without prompting.

import { describe, expect, test } from "bun:test";

import {
  allFilesAreSamospecManaged,
  isSamospecManagedArtifact,
} from "../../src/git/manual-edit.ts";

const SLUG_DIR = ".samo/spec/refunds";

describe("isSamospecManagedArtifact", () => {
  test("recognizes top-level bookkeeping artifacts (case-insensitive)", () => {
    for (const f of [
      `${SLUG_DIR}/state.json`,
      `${SLUG_DIR}/TLDR.md`,
      `${SLUG_DIR}/tldr.md`,
      `${SLUG_DIR}/decisions.md`,
      `${SLUG_DIR}/changelog.md`,
      `${SLUG_DIR}/architecture.json`,
      `${SLUG_DIR}/interview.json`,
    ]) {
      expect(isSamospecManagedArtifact(f, SLUG_DIR)).toBe(true);
    }
  });

  test("recognizes everything under the reviews/ subtree", () => {
    expect(
      isSamospecManagedArtifact(`${SLUG_DIR}/reviews/r01/round.json`, SLUG_DIR),
    ).toBe(true);
    expect(
      isSamospecManagedArtifact(`${SLUG_DIR}/reviews/r02/codex.md`, SLUG_DIR),
    ).toBe(true);
    expect(
      isSamospecManagedArtifact(`${SLUG_DIR}/reviews/r02/claude.md`, SLUG_DIR),
    ).toBe(true);
  });

  test("SPEC.md is NOT managed — it is the user-facing artifact", () => {
    expect(isSamospecManagedArtifact(`${SLUG_DIR}/SPEC.md`, SLUG_DIR)).toBe(
      false,
    );
  });

  test("foreign files dropped into the spec dir are NOT managed", () => {
    expect(isSamospecManagedArtifact(`${SLUG_DIR}/NOTES.md`, SLUG_DIR)).toBe(
      false,
    );
    expect(
      isSamospecManagedArtifact(`${SLUG_DIR}/scratch/notes.txt`, SLUG_DIR),
    ).toBe(false);
  });

  test("paths outside the spec dir are NOT managed", () => {
    expect(isSamospecManagedArtifact("README.md", SLUG_DIR)).toBe(false);
    expect(
      isSamospecManagedArtifact(".samo/spec/other/state.json", SLUG_DIR),
    ).toBe(false);
  });
});

describe("allFilesAreSamospecManaged", () => {
  test("true when every dirty path is samospec's own artifact", () => {
    expect(
      allFilesAreSamospecManaged(
        [`${SLUG_DIR}/state.json`, `${SLUG_DIR}/reviews/r01/round.json`],
        SLUG_DIR,
      ),
    ).toBe(true);
  });

  test("false when a genuine SPEC.md edit is present", () => {
    expect(
      allFilesAreSamospecManaged(
        [`${SLUG_DIR}/state.json`, `${SLUG_DIR}/SPEC.md`],
        SLUG_DIR,
      ),
    ).toBe(false);
  });

  test("false when a foreign file is present", () => {
    expect(
      allFilesAreSamospecManaged(
        [`${SLUG_DIR}/state.json`, `${SLUG_DIR}/NOTES.md`],
        SLUG_DIR,
      ),
    ).toBe(false);
  });

  test("false for an empty list (nothing to auto-incorporate)", () => {
    expect(allFilesAreSamospecManaged([], SLUG_DIR)).toBe(false);
  });
});
