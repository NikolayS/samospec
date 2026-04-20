// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §7 — Manual-edit detection (Sprint 3 #3).
 *
 * Scope: `git status --porcelain -- .samospec/spec/<slug>/` — catches BOTH
 * tracked edits AND new untracked files. `SPEC.md` → three-option
 * incorporate/overwrite/abort prompt. Other committed artifacts
 * (`decisions.md`, `changelog.md`, `TLDR.md`, `interview.json`) →
 * warn-and-confirm. Incorporate commit message is
 * `spec(<slug>): user-edit before round <N>`. On incorporate, the lead's
 * next `revise()` call gets the literal directive:
 *   "The user has manually edited sections {section-names} of the spec
 *    since the last round. Treat their exact wording as final for those
 *    sections; do not rewrite them."
 * Section-name extraction is heuristic — H1/H2 headers touched by the diff.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  applyManualEdit,
  buildLeadDirective,
  detectManualEdits,
  type ManualEditReport,
  type ManualEditChoice,
} from "../../src/git/manual-edit.ts";
import { createTempRepo, type TempRepo } from "./helpers/tempRepo.ts";

function commitSpecStart(repo: TempRepo, slug: string): void {
  // Seed an initial committed SPEC.md under `.samospec/spec/<slug>/` so edits
  // to it register as tracked modifications.
  repo.write(
    `.samospec/spec/${slug}/SPEC.md`,
    "# Refunds v0.1\n\n## Goals\n\nInitial goals.\n\n## Scope\n\nInitial scope.\n",
  );
  repo.write(`.samospec/spec/${slug}/decisions.md`, "# Decisions\n");
  repo.write(`.samospec/spec/${slug}/changelog.md`, "# Changelog\n");
  repo.write(`.samospec/spec/${slug}/TLDR.md`, "# TL;DR v0.1\n");
  repo.write(`.samospec/spec/${slug}/interview.json`, "{}\n");
  repo.run([
    "add",
    "--",
    `.samospec/spec/${slug}/SPEC.md`,
    `.samospec/spec/${slug}/decisions.md`,
    `.samospec/spec/${slug}/changelog.md`,
    `.samospec/spec/${slug}/TLDR.md`,
    `.samospec/spec/${slug}/interview.json`,
  ]);
  repo.run(["commit", "-m", `spec(${slug}): draft v0.1`]);
}

describe("detectManualEdits — scope and classification", () => {
  let repo: TempRepo;
  const slug = "refunds";
  beforeEach(() => {
    repo = createTempRepo({ initialBranch: `samospec/${slug}` });
    commitSpecStart(repo, slug);
  });
  afterEach(() => {
    repo.cleanup();
  });

  test("returns a clean report when the spec dir is untouched", () => {
    const rep = detectManualEdits(slug, { repoPath: repo.dir });
    expect(rep.dirty).toBe(false);
    expect(rep.files).toEqual([]);
    expect(rep.specEdited).toBe(false);
    expect(rep.derivedEdited).toEqual([]);
  });

  test("detects an edited tracked SPEC.md as target=spec", () => {
    repo.write(
      `.samospec/spec/${slug}/SPEC.md`,
      "# Refunds v0.1\n\n## Goals\n\nRewritten goals.\n\n## Scope\n\nInitial scope.\n",
    );
    const rep = detectManualEdits(slug, { repoPath: repo.dir });
    expect(rep.dirty).toBe(true);
    expect(rep.specEdited).toBe(true);
    expect(rep.files.map((f) => f.path)).toContain(
      `.samospec/spec/${slug}/SPEC.md`,
    );
    const spec = rep.files.find((f) => f.path.endsWith("SPEC.md"));
    expect(spec?.target).toBe("spec");
    expect(spec?.status).toBe("modified");
  });

  test("detects a new untracked NOTES.md under the spec dir as target=derived", () => {
    repo.write(
      `.samospec/spec/${slug}/NOTES.md`,
      "# Notes\n\nA user drop-in.\n",
    );
    const rep = detectManualEdits(slug, { repoPath: repo.dir });
    expect(rep.dirty).toBe(true);
    expect(rep.specEdited).toBe(false);
    const notes = rep.files.find((f) => f.path.endsWith("NOTES.md"));
    expect(notes).toBeDefined();
    expect(notes?.target).toBe("derived");
    expect(notes?.status).toBe("untracked");
    expect(rep.derivedEdited.length).toBeGreaterThan(0);
  });

  test("classifies edits to decisions.md, changelog.md, TLDR.md, interview.json as target=derived", () => {
    const artifacts = [
      "decisions.md",
      "changelog.md",
      "TLDR.md",
      "interview.json",
    ];
    for (const a of artifacts) {
      repo.write(`.samospec/spec/${slug}/${a}`, "user tampered\n");
    }
    const rep = detectManualEdits(slug, { repoPath: repo.dir });
    expect(rep.dirty).toBe(true);
    expect(rep.specEdited).toBe(false);
    const derivedSorted = [...rep.derivedEdited].sort();
    const expectedSorted = artifacts
      .map((a) => `.samospec/spec/${slug}/${a}`)
      .sort();
    expect(derivedSorted).toEqual(expectedSorted);
  });

  test("ignores edits outside .samospec/spec/<slug>/", () => {
    repo.write("README.md", "# Unrelated change\n");
    repo.write("src/app.ts", "export {};\n");
    const rep = detectManualEdits(slug, { repoPath: repo.dir });
    expect(rep.dirty).toBe(false);
    expect(rep.files).toEqual([]);
  });

  test("ignores edits in sibling spec dirs", () => {
    // A different slug must not pollute this slug's report.
    commitSpecStart(repo, "other-slug");
    repo.write(
      `.samospec/spec/other-slug/SPEC.md`,
      "# Other spec — tampered\n",
    );
    const rep = detectManualEdits(slug, { repoPath: repo.dir });
    expect(rep.dirty).toBe(false);
    expect(rep.specEdited).toBe(false);
  });
});

describe("buildLeadDirective — section heuristic", () => {
  test("emits the SPEC §7 wording verbatim around the detected sections", () => {
    const before =
      "# Refunds v0.1\n\n## Goals\n\nOriginal goals.\n\n## Scope\n\nOriginal scope.\n";
    const after =
      "# Refunds v0.1\n\n## Goals\n\nRewritten goals text.\n\n## Scope\n\nOriginal scope.\n";
    const directive = buildLeadDirective({ before, after });
    expect(directive).toContain("The user has manually edited sections");
    expect(directive).toContain("Goals");
    expect(directive).not.toContain("Scope");
    expect(directive).toContain(
      "Treat their exact wording as final for those sections; do not rewrite them.",
    );
  });

  test("lists multiple touched H1/H2 headers", () => {
    const before =
      "# Refunds v0.1\n\n## Goals\n\nOriginal goals.\n\n## Scope\n\nOriginal scope.\n";
    const after =
      "# Refunds v0.1 — edited\n\n## Goals\n\nRewritten.\n\n## Scope\n\nAlso rewritten.\n";
    const directive = buildLeadDirective({ before, after });
    expect(directive).toContain("Goals");
    expect(directive).toContain("Scope");
  });

  test("falls back to a generic sentence when no H1/H2 sections were touched", () => {
    const before = "plain text with no headings\n";
    const after = "plain text with no headings and a bit more\n";
    const directive = buildLeadDirective({ before, after });
    // Still explicit about manual edits, still directive.
    expect(directive).toContain("manually edited");
    expect(directive).toContain(
      "Treat their exact wording as final for those sections; do not rewrite them.",
    );
  });
});

describe("applyManualEdit — three-option flow for SPEC.md edits", () => {
  let repo: TempRepo;
  const slug = "refunds";
  beforeEach(() => {
    repo = createTempRepo({ initialBranch: `samospec/${slug}` });
    commitSpecStart(repo, slug);
  });
  afterEach(() => {
    repo.cleanup();
  });

  test("'incorporate' commits user edits with the SPEC §7 message and appends a changelog entry", () => {
    repo.write(
      `.samospec/spec/${slug}/SPEC.md`,
      "# Refunds v0.1\n\n## Goals\n\nRewritten goals.\n\n## Scope\n\nInitial scope.\n",
    );
    const report = detectManualEdits(slug, { repoPath: repo.dir });
    const outcome = applyManualEdit({
      repoPath: repo.dir,
      slug,
      report,
      choice: "incorporate",
      roundNumber: 1,
    });
    expect(outcome.action).toBe("committed");
    // Commit message follows the SPEC §7 directive exactly.
    const messages = repo.logOnBranch(`samospec/${slug}`);
    expect(messages[0]).toBe(`spec(${slug}): user-edit before round 1`);
    // Changelog had a `user-edit` note appended.
    const changelog = repo.run([
      "show",
      `HEAD:.samospec/spec/${slug}/changelog.md`,
    ]).stdout;
    expect(changelog).toContain("user-edit");
    // The lead directive surfaced for the orchestrator to pass in.
    expect(outcome.leadDirective).toContain("manually edited sections");
    expect(outcome.leadDirective).toContain(
      "Treat their exact wording as final for those sections; do not rewrite them.",
    );
  });

  test("'overwrite' discards user edits and does not commit", () => {
    repo.write(`.samospec/spec/${slug}/SPEC.md`, "# USER WIPED\n");
    const report = detectManualEdits(slug, { repoPath: repo.dir });
    const commitsBefore = repo.logOnBranch(`samospec/${slug}`).length;
    const outcome = applyManualEdit({
      repoPath: repo.dir,
      slug,
      report,
      choice: "overwrite",
      roundNumber: 1,
    });
    expect(outcome.action).toBe("discarded");
    const commitsAfter = repo.logOnBranch(`samospec/${slug}`).length;
    expect(commitsAfter).toBe(commitsBefore);
    // Working tree is clean again.
    const after = detectManualEdits(slug, { repoPath: repo.dir });
    expect(after.dirty).toBe(false);
  });

  test("'abort' does not commit and does not mutate state — signals exit 0", () => {
    repo.write(
      `.samospec/spec/${slug}/SPEC.md`,
      "# Refunds v0.1\n\n## Goals\n\nRewritten goals.\n\n## Scope\n\nInitial scope.\n",
    );
    const report = detectManualEdits(slug, { repoPath: repo.dir });
    const commitsBefore = repo.logOnBranch(`samospec/${slug}`).length;
    const outcome = applyManualEdit({
      repoPath: repo.dir,
      slug,
      report,
      choice: "abort",
      roundNumber: 1,
    });
    expect(outcome.action).toBe("aborted");
    // No commits landed.
    const commitsAfter = repo.logOnBranch(`samospec/${slug}`).length;
    expect(commitsAfter).toBe(commitsBefore);
    // User edits remain on disk for the user to handle manually.
    const after = detectManualEdits(slug, { repoPath: repo.dir });
    expect(after.dirty).toBe(true);
  });

  test("derived-only edits do NOT trigger the SPEC three-option flow — warn-and-confirm path", () => {
    repo.write(`.samospec/spec/${slug}/NOTES.md`, "# Notes\nadded by user\n");
    const report = detectManualEdits(slug, { repoPath: repo.dir });
    expect(report.specEdited).toBe(false);
    expect(report.derivedEdited.length).toBeGreaterThan(0);
    // No lead directive when it's derived-only.
    const outcome = applyManualEdit({
      repoPath: repo.dir,
      slug,
      report,
      choice: "incorporate",
      roundNumber: 2,
    });
    expect(outcome.action).toBe("committed");
    // Derived path still records a user-edit commit so work isn't lost.
    const messages = repo.logOnBranch(`samospec/${slug}`);
    expect(messages[0]).toBe(`spec(${slug}): user-edit before round 2`);
    // But no lead directive is emitted for derived-only edits.
    expect(outcome.leadDirective).toBeUndefined();
  });

  test("validates choice union at runtime", () => {
    const report: ManualEditReport = {
      dirty: false,
      files: [],
      specEdited: false,
      derivedEdited: [],
    };
    // Clean report + any choice = no-op.
    const outcome = applyManualEdit({
      repoPath: repo.dir,
      slug,
      report,
      choice: "incorporate" satisfies ManualEditChoice,
      roundNumber: 1,
    });
    expect(outcome.action).toBe("noop");
  });
});
