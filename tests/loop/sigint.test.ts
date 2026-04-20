// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §12 condition 5 — SIGINT handling.
 *
 * When the user hits Ctrl-C, the loop exits cleanly with
 * exit_reason=sigint (exit code 3 per SPEC §10). We simulate this via
 * the `sigintSignal.triggered` test seam — an abstract boolean flag
 * that makes the loop believe SIGINT was received before the
 * stopping-conditions check.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type { CritiqueOutput } from "../../src/adapter/types.ts";
import { runIterate, type IterateResolvers } from "../../src/cli/iterate.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-sigint-"));
  initRepo(tmp);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function initRepo(cwd: string): void {
  spawnSync("git", ["init", "-q"], { cwd });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd });
  spawnSync("git", ["config", "user.name", "Test"], { cwd });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd });
  spawnSync("git", ["checkout", "-q", "-b", "samospec/refunds"], { cwd });
  writeFileSync(path.join(cwd, "README.md"), "seed\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd });
}

function seedSpec(cwd: string, slug: string): void {
  const slugDir = path.join(cwd, ".samo", "spec", slug);
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(path.join(slugDir, "SPEC.md"), "# SPEC\n\nv0.1 body\n", "utf8");
  writeFileSync(path.join(slugDir, "TLDR.md"), "# TLDR\n", "utf8");
  writeFileSync(
    path.join(slugDir, "decisions.md"),
    "# decisions\n\n- placeholder\n",
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "changelog.md"),
    "# changelog\n\n## v0.1 — seed\n",
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "interview.json"),
    JSON.stringify({
      slug,
      persona: 'Veteran "refunds" expert',
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
    persona: { skill: "refunds", accepted: true },
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
  spawnSync("git", ["commit", "-q", "-m", "spec(refunds): draft v0.1"], {
    cwd,
  });
}

const RESOLVERS: IterateResolvers = {
  onManualEdit: () => Promise.resolve("incorporate"),
  onDegraded: () => Promise.resolve("accept"),
  onReviewerExhausted: () => Promise.resolve("abort"),
};

const SAMPLE_CRITIQUE: CritiqueOutput = {
  findings: [
    {
      category: "ambiguity",
      text: "spec is ambiguous about refunds",
      severity: "minor",
    },
  ],
  summary: "one ambiguity",
  suggested_next_version: "0.2",
  usage: null,
  effort_used: "max",
};

describe("loop/sigint — SPEC §12 condition 5", () => {
  test("pre-fired SIGINT causes sigint stop reason + exit code 3", async () => {
    seedSpec(tmp, "refunds");

    const lead = createFakeAdapter({
      revise: {
        spec: "# SPEC\n\npost-round-1 body\n",
        ready: false,
        rationale: "[]",
        usage: null,
        effort_used: "max",
      },
    });
    const crit = createFakeAdapter({ critique: SAMPLE_CRITIQUE });

    const res = await runIterate({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T12:00:00Z",
      resolvers: RESOLVERS,
      adapters: { lead, reviewerA: crit, reviewerB: crit },
      maxRounds: 5,
      sessionStartedAtMs: 0,
      nowMs: 0,
      maxWallClockMs: 60 * 60 * 1000,
      sigintSignal: { triggered: true },
    });
    expect(res.stopReason).toBe("sigint");
    expect(res.exitCode).toBe(3);

    const finalState: State = JSON.parse(
      readFileSync(
        path.join(tmp, ".samo", "spec", "refunds", "state.json"),
        "utf8",
      ),
    );
    expect(finalState.exit?.reason).toBe("sigint");
    expect(finalState.exit?.code).toBe(3);
  });
});
