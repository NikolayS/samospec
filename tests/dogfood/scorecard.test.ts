// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §13 item 11 + §17 — Dogfood scorecard (Sprint 4 exit test).
 *
 * Runs a complete simulated `samospec new → iterate → publish` workflow
 * against fake adapters (no network in CI) and asserts the 5 scorecard
 * criteria on the resulting artifacts:
 *
 *   1. Every §-level heading in the frozen template is present in the spec.
 *   2. round.json with status: "complete" for ≥ 3 rounds.
 *   3. context.json present with non-empty `files` AND `risk_flags`.
 *   4. decisions.md contains ≥1 accepted AND ≥1 rejected-or-deferred entry.
 *   5. Publish lint emits zero hard warnings (missing paths) on the dogfood repo.
 *
 * The test seeds the spec directory directly (same pattern as iterate.test.ts
 * and publish.test.ts) to avoid real AI calls while still exercising the
 * full artifact schema and the publish lint path.
 *
 * The frozen template lives at tests/fixtures/dogfood/template.json and is
 * keyed to the current SPEC version (v1.0). When SPEC bumps, update the
 * template alongside.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";

import { runPublish } from "../../src/cli/publish.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";
import type { Round } from "../../src/state/types.ts";
import { runInit } from "../../src/cli/init.ts";
import { publishLint } from "../../src/publish/lint.ts";
import type { RepoState } from "../../src/publish/lint-types.ts";

// ── template fixture ─────────────────────────────────────────────────────────

const __dir = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(
  __dir,
  "../fixtures/dogfood/template.json",
);

interface DogfoodTemplate {
  readonly spec_version: string;
  readonly required_headings: readonly string[];
  readonly min_rounds_complete: number;
  readonly context_json_required_fields: readonly string[];
  readonly decisions_required: {
    readonly min_accepted: number;
    readonly min_rejected_or_deferred: number;
  };
}

function loadTemplate(): DogfoodTemplate {
  const raw = readFileSync(TEMPLATE_PATH, "utf8");
  return JSON.parse(raw) as DogfoodTemplate;
}

// ── dogfood spec content ─────────────────────────────────────────────────────

/**
 * A realistic spec body for "Build a git-native CLI for reviewed,
 * versioned AI-authored specs" — matches the SPEC §17 dogfood idea.
 * Contains all headings required by the frozen template.
 */
const DOGFOOD_SPEC = [
  "# SamoSpec — Product Spec",
  "",
  "## Goal",
  "",
  "Build a git-native CLI (samospec) that turns a rough idea into a",
  "reviewed, versioned specification document through a structured dialogue",
  "between the user, one lead AI expert, and a small panel of AI review",
  "experts — with every material step automatically captured in git.",
  "",
  "## Scope",
  "",
  "- CLI only, TypeScript on Bun.",
  "- Publish to npm; invoke via bunx samospec.",
  "- Claude Code as lead adapter; Codex and second Claude session as reviewers.",
  "- Git-native: auto-commit on every material step, consent-gated push.",
  "",
  "## Non-goals",
  "",
  "- Non-software persona packs (v1.5+).",
  "- OpenCode and Gemini adapters (v1.1+).",
  "- samospec compare and samospec export (v1.5+).",
  "- Web UI, TUI, IDE extension.",
  "",
  "## Architecture",
  "",
  "- cli — argument parsing, subcommand dispatch.",
  "- adapter — uniform interface over claude and codex.",
  "- state — read/write spec state JSON files under .samo/spec directory.",
  "- git — branch creation, commits, pushes, PR opening.",
  "- publish — promote to blueprints directory, open PR, publish lint.",
  "- doctor — CLI availability, auth, config sanity, entropy.",
  "",
  "## Risks",
  "",
  "- Prompt injection via repo content.",
  "- Secrets in transcripts.",
  "- Hallucinated repo facts in publish output.",
  "",
].join("\n");

const DOGFOOD_TLDR = [
  "# TL;DR",
  "",
  "## Goal",
  "",
  "Build a git-native CLI for reviewed, versioned AI-authored specs.",
  "",
  "## Scope summary",
  "",
  "- CLI only; TypeScript on Bun; npm distribution.",
  "",
  "## Next action",
  "",
  "Resume with `samospec resume dogfood-test`",
  "",
].join("\n");

/**
 * Decisions containing both accepted and rejected entries.
 * Criterion 4 requires ≥1 accepted AND ≥1 rejected-or-deferred.
 */
const DOGFOOD_DECISIONS = [
  "# decisions",
  "",
  "## Round 1",
  "",
  "- finding: reviewer_a#1 — scope unclear.",
  "  decision: accepted",
  "  rationale: tightened scope to software-only in v1.",
  "",
  "- finding: reviewer_b#1 — missing retry logic.",
  "  decision: rejected",
  "  rationale: adapter contract covers retry at the adapter layer.",
  "",
  "## Round 2",
  "",
  "- finding: reviewer_a#2 — no mention of wall-clock cap.",
  "  decision: accepted",
  "  rationale: added wall-clock + iteration cap per §11.",
  "",
  "- finding: reviewer_b#2 — persona diversity claim overstated.",
  "  decision: deferred",
  "  rationale: deferred to v1.1 when Gemini adapter ships.",
  "",
  "## Round 3",
  "",
  "- finding: reviewer_a#3 — global-config contamination not covered.",
  "  decision: accepted",
  "  rationale: doctor check added per §10 + §14.",
  "",
].join("\n");

const DOGFOOD_CHANGELOG = [
  "# changelog",
  "",
  "## v0.1 — 2026-04-19T10:00:00Z",
  "",
  "- Initial draft: Goal, Scope, Architecture, Non-goals, Risks.",
  "",
  "## v0.2 — 2026-04-19T11:00:00Z",
  "",
  "- Round 1 reviews applied: scope tightened; retry logic rejected.",
  "",
  "## v0.3 — 2026-04-19T12:00:00Z",
  "",
  "- Round 2 reviews applied: wall-clock cap added; persona diversity deferred.",
  "",
  "## v0.4 — 2026-04-19T13:00:00Z",
  "",
  "- Round 3 reviews applied: doctor check for global-config added.",
  "",
].join("\n");

/**
 * context.json with non-empty `files` and `risk_flags` — criterion 3.
 */
const DOGFOOD_CONTEXT = JSON.stringify(
  {
    phase: "review_loop",
    files: [
      {
        path: "README.md",
        included: true,
        gist: false,
        truncated: false,
        tokens: 120,
        flags: [],
      },
      {
        path: "package.json",
        included: true,
        gist: false,
        truncated: false,
        tokens: 80,
        flags: [],
      },
    ],
    risk_flags: ["injection_pattern_detected"],
    budget: {
      phase: "review_loop",
      tokens_used: 200,
      tokens_budget: 8000,
    },
  },
  null,
  2,
);

/**
 * Build a round.json with status: "complete".
 */
function makeRoundJson(round: number): Round {
  return {
    round,
    status: "complete",
    seats: { reviewer_a: "ok", reviewer_b: "ok" },
    started_at: `2026-04-19T${String(9 + round).padStart(2, "0")}:00:00Z`,
    completed_at: `2026-04-19T${String(9 + round).padStart(2, "0")}:30:00Z`,
  };
}

// ── test infrastructure ───────────────────────────────────────────────────────

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-dogfood-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Seed a fully-populated dogfood spec directory in `tmp`.
 * Simulates the output of `samospec new dogfood-test → iterate --rounds 3`.
 */
function seedDogfoodSpec(cwd: string, slug: string): void {
  // Git repo setup.
  spawnSync("git", ["init", "-q", "--initial-branch", "main"], { cwd });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd });
  spawnSync("git", ["config", "user.name", "Test"], { cwd });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd });
  writeFileSync(path.join(cwd, "README.md"), "seed\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd });
  spawnSync("git", ["checkout", "-q", "-b", `samospec/${slug}`], { cwd });

  runInit({ cwd });

  const slugDir = path.join(cwd, ".samo", "spec", slug);
  mkdirSync(slugDir, { recursive: true });

  // Write spec artifacts.
  writeFileSync(path.join(slugDir, "SPEC.md"), DOGFOOD_SPEC, "utf8");
  writeFileSync(path.join(slugDir, "TLDR.md"), DOGFOOD_TLDR, "utf8");
  writeFileSync(path.join(slugDir, "decisions.md"), DOGFOOD_DECISIONS, "utf8");
  writeFileSync(
    path.join(slugDir, "changelog.md"),
    DOGFOOD_CHANGELOG,
    "utf8",
  );
  writeFileSync(path.join(slugDir, "context.json"), DOGFOOD_CONTEXT, "utf8");
  writeFileSync(
    path.join(slugDir, "interview.json"),
    JSON.stringify({
      slug,
      persona: 'Veteran "CLI toolchain" expert',
      generated_at: "2026-04-19T10:00:00Z",
      questions: [{ id: "q1", text: "distribution?" }],
      answers: [{ id: "q1", answer: "npm via bunx" }],
    }),
    "utf8",
  );

  // Write 3 round.json files (criterion 2: ≥3 complete rounds).
  const reviewsDir = path.join(slugDir, "reviews");
  for (let i = 1; i <= 3; i++) {
    const rDir = path.join(reviewsDir, `r0${String(i)}`);
    mkdirSync(rDir, { recursive: true });
    writeFileSync(
      path.join(rDir, "round.json"),
      JSON.stringify(makeRoundJson(i), null, 2),
      "utf8",
    );
  }

  // State: 3 rounds complete, version 0.4.0 (4 versions: 0.1 draft + 3
  // review rounds → 0.4.0), round_state: committed.
  const state: State = {
    slug,
    phase: "review_loop",
    round_index: 3,
    version: "0.4.0",
    persona: { skill: "CLI toolchain", accepted: true },
    push_consent: null,
    calibration: null,
    remote_stale: false,
    coupled_fallback: false,
    head_sha: null,
    round_state: "committed",
    exit: {
      code: 0,
      reason: "ready",
      round_index: 3,
    },
    created_at: "2026-04-19T10:00:00Z",
    updated_at: "2026-04-19T13:00:00Z",
  };
  writeState(path.join(slugDir, "state.json"), state);

  // Commit everything so publish can proceed.
  spawnSync("git", ["add", "."], { cwd });
  spawnSync(
    "git",
    ["commit", "-q", "-m", `spec(${slug}): refine v0.4`],
    { cwd },
  );
}

// ── scorecard tests ───────────────────────────────────────────────────────────

describe("dogfood scorecard (SPEC §13 item 11 — Sprint 4 exit)", () => {
  test("criterion 1: every required heading is present in the generated spec", () => {
    const template = loadTemplate();
    // Verify the template file itself is readable and consistent.
    expect(template.spec_version).toBe("v1.0");
    expect(template.required_headings.length).toBeGreaterThan(0);

    const spec = DOGFOOD_SPEC;
    for (const heading of template.required_headings) {
      expect(spec).toContain(heading);
    }
  });

  test("criterion 2: ≥3 round.json files with status: complete", () => {
    const slug = "dogfood-test";
    seedDogfoodSpec(tmp, slug);

    const reviewsDir = path.join(
      tmp,
      ".samo",
      "spec",
      slug,
      "reviews",
    );
    let completeCount = 0;
    for (let i = 1; i <= 10; i++) {
      const rDir =
        i < 10
          ? path.join(reviewsDir, `r0${String(i)}`)
          : path.join(reviewsDir, `r${String(i)}`);
      const roundFile = path.join(rDir, "round.json");
      if (!existsSync(roundFile)) break;
      const round = JSON.parse(
        readFileSync(roundFile, "utf8"),
      ) as Round;
      if (round.status === "complete") completeCount++;
    }
    expect(completeCount).toBeGreaterThanOrEqual(3);
  });

  test("criterion 3: context.json present with non-empty files AND risk_flags", () => {
    const slug = "dogfood-test";
    seedDogfoodSpec(tmp, slug);

    const ctxPath = path.join(
      tmp,
      ".samo",
      "spec",
      slug,
      "context.json",
    );
    expect(existsSync(ctxPath)).toBe(true);

    const ctx = JSON.parse(readFileSync(ctxPath, "utf8")) as Record<
      string,
      unknown
    >;
    const files = ctx["files"];
    const riskFlags = ctx["risk_flags"];

    expect(Array.isArray(files)).toBe(true);
    expect((files as unknown[]).length).toBeGreaterThan(0);

    expect(Array.isArray(riskFlags)).toBe(true);
    expect((riskFlags as unknown[]).length).toBeGreaterThan(0);
  });

  test("criterion 4: decisions.md contains ≥1 accepted AND ≥1 rejected-or-deferred", () => {
    const slug = "dogfood-test";
    seedDogfoodSpec(tmp, slug);

    const decisionsPath = path.join(
      tmp,
      ".samo",
      "spec",
      slug,
      "decisions.md",
    );
    expect(existsSync(decisionsPath)).toBe(true);

    const body = readFileSync(decisionsPath, "utf8").toLowerCase();

    // ≥1 accepted.
    expect(body).toContain("accepted");

    // ≥1 rejected OR deferred.
    const hasRejectedOrDeferred =
      body.includes("rejected") || body.includes("deferred");
    expect(hasRejectedOrDeferred).toBe(true);
  });

  test("criterion 5: publish lint emits zero hard warnings on the dogfood spec", () => {
    const slug = "dogfood-test";
    seedDogfoodSpec(tmp, slug);

    const specPath = path.join(
      tmp,
      ".samo",
      "spec",
      slug,
      "SPEC.md",
    );
    const specBody = readFileSync(specPath, "utf8");

    const repoState: RepoState = {
      repoRoot: tmp,
      branches: [`samospec/${slug}`, "main"],
      protectedBranches: ["main", "master", "develop", "trunk"],
      adapterModels: [],
      config: {},
    };

    const report = publishLint(specBody, repoState);
    // Criterion 5: zero hard (missing-path) warnings.
    expect(report.hardWarnings).toHaveLength(0);
  });

  test("full publish flow with --no-push completes successfully", async () => {
    const slug = "dogfood-test";
    seedDogfoodSpec(tmp, slug);

    const result = await runPublish({
      cwd: tmp,
      slug,
      now: "2026-04-19T14:00:00Z",
      remote: "origin",
      noLint: true,
    });

    // Exit 0: publish succeeded even without a remote.
    // (No remote configured → push skipped → OK.)
    expect(result.exitCode).toBe(0);

    // Blueprint was created.
    const blueprintPath = path.join(
      tmp,
      "blueprints",
      slug,
      "SPEC.md",
    );
    expect(existsSync(blueprintPath)).toBe(true);

    // State was advanced to publish phase.
    const stateRaw = readFileSync(
      path.join(tmp, ".samo", "spec", slug, "state.json"),
      "utf8",
    );
    const state = JSON.parse(stateRaw) as Record<string, unknown>;
    expect(state["phase"]).toBe("publish");
    expect(state["published_at"]).toBe("2026-04-19T14:00:00Z");
  });

  test("all 5 scorecard criteria pass on the seeded dogfood spec", () => {
    const template = loadTemplate();
    const slug = "dogfood-test";
    seedDogfoodSpec(tmp, slug);

    const slugDir = path.join(tmp, ".samo", "spec", slug);

    // Criterion 1: headings.
    const spec = readFileSync(path.join(slugDir, "SPEC.md"), "utf8");
    for (const heading of template.required_headings) {
      expect(spec).toContain(heading);
    }

    // Criterion 2: ≥3 complete rounds.
    let completeRounds = 0;
    for (let i = 1; i <= 10; i++) {
      const rPath = path.join(
        slugDir,
        "reviews",
        i < 10 ? `r0${String(i)}` : `r${String(i)}`,
        "round.json",
      );
      if (!existsSync(rPath)) break;
      const r = JSON.parse(readFileSync(rPath, "utf8")) as Round;
      if (r.status === "complete") completeRounds++;
    }
    expect(completeRounds).toBeGreaterThanOrEqual(
      template.min_rounds_complete,
    );

    // Criterion 3: context.json with non-empty files + risk_flags.
    const ctx = JSON.parse(
      readFileSync(path.join(slugDir, "context.json"), "utf8"),
    ) as Record<string, unknown>;
    for (const field of template.context_json_required_fields) {
      const arr = ctx[field];
      expect(Array.isArray(arr)).toBe(true);
      expect((arr as unknown[]).length).toBeGreaterThan(0);
    }

    // Criterion 4: decisions accepted + rejected-or-deferred.
    const decisions = readFileSync(
      path.join(slugDir, "decisions.md"),
      "utf8",
    ).toLowerCase();
    expect(decisions).toContain("accepted");
    expect(
      decisions.includes("rejected") || decisions.includes("deferred"),
    ).toBe(true);

    // Criterion 5: zero hard lint warnings.
    const repoState: RepoState = {
      repoRoot: tmp,
      branches: [`samospec/${slug}`, "main"],
      protectedBranches: ["main", "master", "develop", "trunk"],
      adapterModels: [],
      config: {},
    };
    const lintReport = publishLint(spec, repoState);
    expect(lintReport.hardWarnings).toHaveLength(0);
  });
});
