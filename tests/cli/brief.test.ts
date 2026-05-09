// Copyright 2026 Nikolay Samokhvalov.

// Contract tests for `samospec brief <slug>`.
//
// These tests pin the user-facing behavior:
//   - Refuses if no slug, no spec, or not yet published — with
//     actionable error messages.
//   - Writes BRIEF.html under the configured blueprints dir.
//   - Idempotently creates `.nojekyll` at repo root (GH Pages
//     friendliness) unless `--no-nojekyll` opts out.
//   - `--out` overrides the output path (relative or absolute) so
//     users can target `docs/`, `public/`, etc.
//   - Honors `paths.blueprints_dir` from `.samo/config.json` — the
//     same configurability that the upcoming dir rename relies on.
//   - Does not auto-commit (brief is a derivative; user decides).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runBrief } from "../../src/cli/brief.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

let tmp: string;
const NOW = "2026-05-09T12:00:00Z";
const PUBLISHED_AT = "2026-05-09T11:55:00Z";
const CREATED_AT = "2026-05-01T09:00:00Z";

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-brief-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function publishedState(slug: string, overrides: Partial<State> = {}): State {
  return {
    slug,
    phase: "publish",
    round_index: 2,
    version: "0.2.0",
    persona: { skill: "software-eng-pragmatic", accepted: true },
    push_consent: null,
    calibration: null,
    remote_stale: false,
    coupled_fallback: false,
    head_sha: null,
    round_state: "committed",
    exit: { code: 0, reason: "committed", round_index: 2 },
    adapters: {
      lead: {
        adapter: "claude",
        model_id: "claude-opus-4-7",
        effort_requested: "max",
        effort_used: "max",
      },
      reviewer_a: {
        adapter: "codex",
        model_id: "gpt-5.4",
        effort_requested: "max",
        effort_used: "max",
      },
      reviewer_b: {
        adapter: "claude",
        model_id: "claude-opus-4-7",
        effort_requested: "max",
        effort_used: "max",
      },
    },
    published_at: PUBLISHED_AT,
    published_version: "v0.2",
    created_at: CREATED_AT,
    updated_at: PUBLISHED_AT,
    ...overrides,
  } as State;
}

function seedSpec(
  cwd: string,
  slug: string,
  options: { published?: boolean; blueprintsDir?: string } = {},
): void {
  const specDir = path.join(cwd, ".samo", "spec", slug);
  mkdirSync(specDir, { recursive: true });

  writeFileSync(
    path.join(specDir, "TLDR.md"),
    "# TL;DR\n\n## Goal\n\nSummary goal.\n",
    "utf8",
  );
  writeFileSync(
    path.join(specDir, "changelog.md"),
    "# changelog\n\n## v0.1 — 2026-05-01\n\n- Initial draft.\n\n" +
      "## v0.2 — 2026-05-09\n\n- Round 1 review applied.\n",
    "utf8",
  );

  const state =
    options.published === false
      ? ({
          ...publishedState(slug),
          published_at: undefined,
          published_version: undefined,
          round_state: "lead_revised",
          phase: "review_loop",
        } as State)
      : publishedState(slug);
  writeState(path.join(specDir, "state.json"), state);

  if (options.published !== false) {
    const blueprintsDir = options.blueprintsDir ?? "blueprints";
    const bp = path.join(cwd, blueprintsDir, slug);
    mkdirSync(bp, { recursive: true });
    writeFileSync(
      path.join(bp, "SPEC.md"),
      "# Alpha spec\n\n" +
        "## Goal\n\nMake alpha customers happier.\n\n" +
        "## Scope\n\nRefunds API.\n",
      "utf8",
    );
  }
}

describe("samospec brief — preconditions", () => {
  test("refuses with exit 1 and a clear message when slug is missing", () => {
    const r = runBrief({ cwd: tmp, slug: "", now: NOW });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("missing <slug>");
  });

  test("refuses when no spec exists for the slug, suggests `samospec new`", () => {
    const r = runBrief({ cwd: tmp, slug: "ghost", now: NOW });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no spec found for slug 'ghost'");
    expect(r.stderr).toContain("samospec new ghost");
  });

  test("refuses when the spec is not yet published, suggests `samospec publish`", () => {
    seedSpec(tmp, "alpha", { published: false });
    const r = runBrief({ cwd: tmp, slug: "alpha", now: NOW });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not yet published");
    expect(r.stderr).toContain("samospec publish alpha");
  });

  test("refuses when state.json is malformed JSON", () => {
    const slugDir = path.join(tmp, ".samo", "spec", "broken");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(path.join(slugDir, "state.json"), "{ not json", "utf8");
    const r = runBrief({ cwd: tmp, slug: "broken", now: NOW });
    expect(r.exitCode).toBe(1);
  });

  test("refuses when published spec is missing from blueprints dir", () => {
    seedSpec(tmp, "alpha");
    rmSync(path.join(tmp, "blueprints", "alpha", "SPEC.md"));
    const r = runBrief({ cwd: tmp, slug: "alpha", now: NOW });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("published SPEC.md missing");
  });
});

describe("samospec brief — happy path", () => {
  test("writes BRIEF.html next to the published SPEC.md by default", () => {
    seedSpec(tmp, "alpha");
    const r = runBrief({ cwd: tmp, slug: "alpha", now: NOW });
    expect(r.exitCode).toBe(0);
    const briefPath = path.join(tmp, "blueprints", "alpha", "BRIEF.html");
    expect(existsSync(briefPath)).toBe(true);
    const html = readFileSync(briefPath, "utf8");
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Alpha spec");
    expect(html).toContain("Make alpha customers happier");
  });

  test("stdout reports the relative output path and a commit hint", () => {
    seedSpec(tmp, "alpha");
    const r = runBrief({ cwd: tmp, slug: "alpha", now: NOW });
    expect(r.stdout).toContain(
      `wrote ${path.join("blueprints", "alpha", "BRIEF.html")}`,
    );
    expect(r.stdout).toContain("git add");
    expect(r.stdout).toContain("Commit it to publish via Pages");
  });

  test("creates a repo-root `.nojekyll` marker on first run", () => {
    seedSpec(tmp, "alpha");
    const r = runBrief({ cwd: tmp, slug: "alpha", now: NOW });
    expect(r.exitCode).toBe(0);
    expect(existsSync(path.join(tmp, ".nojekyll"))).toBe(true);
    expect(r.stdout).toContain(".nojekyll");
  });

  test(".nojekyll creation is idempotent — pre-existing file preserved, no notice", () => {
    seedSpec(tmp, "alpha");
    writeFileSync(path.join(tmp, ".nojekyll"), "preserved\n", "utf8");
    const r = runBrief({ cwd: tmp, slug: "alpha", now: NOW });
    expect(r.exitCode).toBe(0);
    // Pre-existing content is not overwritten.
    expect(readFileSync(path.join(tmp, ".nojekyll"), "utf8")).toBe(
      "preserved\n",
    );
    // No "created .nojekyll" line in stdout (we left it alone).
    expect(r.stdout).not.toContain("created .nojekyll");
  });

  test("--no-nojekyll skips the marker entirely", () => {
    seedSpec(tmp, "alpha");
    const r = runBrief({
      cwd: tmp,
      slug: "alpha",
      now: NOW,
      noNojekyll: true,
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(path.join(tmp, ".nojekyll"))).toBe(false);
  });

  test("re-running overwrites the existing brief deterministically", () => {
    seedSpec(tmp, "alpha");
    const a = runBrief({ cwd: tmp, slug: "alpha", now: NOW });
    expect(a.exitCode).toBe(0);
    const first = readFileSync(
      path.join(tmp, "blueprints", "alpha", "BRIEF.html"),
      "utf8",
    );
    const b = runBrief({ cwd: tmp, slug: "alpha", now: NOW });
    expect(b.exitCode).toBe(0);
    const second = readFileSync(
      path.join(tmp, "blueprints", "alpha", "BRIEF.html"),
      "utf8",
    );
    expect(second).toBe(first);
  });
});

describe("samospec brief — output path overrides", () => {
  test("--out with a relative path writes there instead of the default", () => {
    seedSpec(tmp, "alpha");
    const r = runBrief({
      cwd: tmp,
      slug: "alpha",
      now: NOW,
      out: "docs/alpha/index.html",
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(path.join(tmp, "docs", "alpha", "index.html"))).toBe(
      true,
    );
    // Default location not written
    expect(
      existsSync(path.join(tmp, "blueprints", "alpha", "BRIEF.html")),
    ).toBe(false);
  });

  test("--out with an absolute path is honored verbatim", () => {
    seedSpec(tmp, "alpha");
    const target = path.join(tmp, "absolute-out", "alpha.html");
    const r = runBrief({
      cwd: tmp,
      slug: "alpha",
      now: NOW,
      out: target,
    });
    expect(r.exitCode).toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  test("--out creates intermediate directories", () => {
    seedSpec(tmp, "alpha");
    const r = runBrief({
      cwd: tmp,
      slug: "alpha",
      now: NOW,
      out: "deep/nested/dir/brief.html",
    });
    expect(r.exitCode).toBe(0);
    expect(
      existsSync(path.join(tmp, "deep", "nested", "dir", "brief.html")),
    ).toBe(true);
  });
});

describe("samospec brief — honors paths.blueprints_dir config", () => {
  test("reads from and writes to the configured blueprints dir", () => {
    // Configure a non-default blueprints dir.
    mkdirSync(path.join(tmp, ".samo"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".samo", "config.json"),
      JSON.stringify(
        { schema_version: 1, paths: { blueprints_dir: "samospec/blueprints" } },
        null,
        2,
      ),
      "utf8",
    );
    seedSpec(tmp, "alpha", { blueprintsDir: "samospec/blueprints" });
    const r = runBrief({ cwd: tmp, slug: "alpha", now: NOW });
    expect(r.exitCode).toBe(0);
    expect(
      existsSync(
        path.join(tmp, "samospec", "blueprints", "alpha", "BRIEF.html"),
      ),
    ).toBe(true);
    // Default location must NOT have been written.
    expect(
      existsSync(path.join(tmp, "blueprints", "alpha", "BRIEF.html")),
    ).toBe(false);
  });
});
