// Copyright 2026 Nikolay Samokhvalov.

// Issue #139: the protected-branch refusal in runIterate should use
// the same wording as src/cli/new.ts — naming the "built-in default"
// source and recommending `samospec/<slug>`.
//
// Before the fix, the iterate commit path emitted:
//   "samospec: cannot commit on protected branch 'main'.
//    Check out samospec/... and re-run."
//
// After the fix it must also contain "built-in default".

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type { Adapter, CritiqueOutput } from "../../src/adapter/types.ts";
import { runIterate, type IterateResolvers } from "../../src/cli/iterate.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

const ACCEPT_RESOLVERS: IterateResolvers = {
  onManualEdit: () => Promise.resolve("incorporate"),
  onDegraded: () => Promise.resolve("accept"),
  onReviewerExhausted: () => Promise.resolve("abort"),
};

const DEFAULT_TIME_INPUTS = {
  sessionStartedAtMs: 0,
  nowMs: 0,
  maxWallClockMs: 60 * 60 * 1000,
};

const SAMPLE_CRITIQUE: CritiqueOutput = {
  findings: [
    {
      category: "ambiguity",
      text: "spec is ambiguous",
      severity: "minor",
    },
  ],
  summary: "one ambiguity",
  suggested_next_version: "0.2",
  usage: null,
  effort_used: "max",
};

function initProtectedRepo(cwd: string): void {
  spawnSync("git", ["init", "-q", "--initial-branch=main"], { cwd });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd });
  spawnSync("git", ["config", "user.name", "Test"], { cwd });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd });
  writeFileSync(path.join(cwd, "README.md"), "seed\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd });
}

function seedSpec(cwd: string, slug: string): void {
  const slugDir = path.join(cwd, ".samo", "spec", slug);
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(
    path.join(slugDir, "SPEC.md"),
    "# SPEC\n\ncontent v0.1\n",
    "utf8",
  );
  writeFileSync(path.join(slugDir, "TLDR.md"), "# TLDR\n\n- old\n", "utf8");
  writeFileSync(
    path.join(slugDir, "decisions.md"),
    "# decisions\n\n- No review-loop decisions yet.\n",
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "changelog.md"),
    "# changelog\n\n## v0.1 — seed\n\n- initial\n",
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "interview.json"),
    JSON.stringify({
      slug,
      persona: `Veteran "${slug}" expert`,
      generated_at: "2026-04-19T12:00:00Z",
      questions: [],
      answers: [],
    }),
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "context.json"),
    JSON.stringify({
      phase: "draft",
      files: [],
      risk_flags: [],
      budget: { phase: "draft", tokens_used: 0, tokens_budget: 0 },
    }),
    "utf8",
  );
  const state: State = {
    slug,
    phase: "review_loop",
    round_index: 0,
    version: "0.1.0",
    persona: { skill: slug, accepted: true },
    push_consent: null,
    calibration: null,
    remote_stale: false,
    coupled_fallback: false,
    head_sha: null,
    round_state: "committed",
    exit: null,
    created_at: "2026-04-19T12:00:00Z",
    updated_at: "2026-04-19T12:00:00Z",
  };
  writeState(path.join(slugDir, "state.json"), state);
  spawnSync("git", ["add", "."], { cwd });
  spawnSync("git", ["commit", "-q", "-m", `spec(${slug}): draft v0.1`], {
    cwd,
  });
}

describe("cli/iterate — protected-branch refusal uses #126 wording (issue #139)", () => {
  test(
    "commit on built-in-protected branch 'main' → " +
      "stderr contains 'built-in default' and 'samospec/'",
    async () => {
      const tmp = mkdtempSync(
        path.join(tmpdir(), "samospec-iterate-protected-"),
      );
      try {
        initProtectedRepo(tmp);
        seedSpec(tmp, "myfeature");

        const lead: Adapter = {
          ...createFakeAdapter({
            revise: {
              spec: "# SPEC\n\ncontent v0.2\n",
              ready: true,
              rationale: JSON.stringify([
                {
                  finding_ref: "codex#1",
                  decision: "accepted",
                  rationale: "yes",
                },
              ]),
              usage: null,
              effort_used: "max",
            },
          }),
        };
        const revA = createFakeAdapter({ critique: SAMPLE_CRITIQUE });
        const revB = createFakeAdapter({ critique: SAMPLE_CRITIQUE });

        const res = await runIterate({
          cwd: tmp,
          slug: "myfeature",
          now: "2026-04-19T12:00:00Z",
          resolvers: ACCEPT_RESOLVERS,
          adapters: { lead, reviewerA: revA, reviewerB: revB },
          maxRounds: 1,
          ...DEFAULT_TIME_INPUTS,
        });

        expect(res.exitCode).toBe(2);
        expect(res.stderr).toContain("built-in default");
        expect(res.stderr).toContain("samospec/");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
