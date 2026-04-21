// Copyright 2026 Nikolay Samokhvalov.

/**
 * RED tests for #71: after `samospec iterate` exits with a stop reason,
 * stdout/stderr contains an appropriate `next:` hint.
 *
 * Success reasons (max-rounds, ready, semantic-convergence):
 *   stdout contains `next: samospec publish <slug>`
 *
 * Failure reasons (reviewers-exhausted, lead_terminal):
 *   stdout/stderr contains recovery hint
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type { Adapter, CritiqueOutput } from "../../src/adapter/types.ts";
import { runIterate, type IterateResolvers } from "../../src/cli/iterate.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-iterate-next-step-"));
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
  spawnSync("git", ["checkout", "-q", "-b", "samospec/my-spec"], { cwd });
  writeFileSync(path.join(cwd, "README.md"), "seed\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd });
}

const SLUG = "my-spec";
const NOW = "2026-04-19T12:00:00Z";

function seedSpec(cwd: string, slug: string): State {
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
      generated_at: NOW,
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
    created_at: NOW,
    updated_at: NOW,
  };
  writeState(path.join(slugDir, "state.json"), state);
  spawnSync("git", ["add", "."], { cwd });
  spawnSync("git", ["commit", "-q", "-m", `spec(${slug}): draft v0.1`], {
    cwd,
  });
  return state;
}

const NO_OP_RESOLVERS: IterateResolvers = {
  onManualEdit: () => Promise.resolve("incorporate"),
  onDegraded: () => Promise.resolve("accept"),
  onReviewerExhausted: () => Promise.resolve("abort"),
};

const FAST_TIME = {
  sessionStartedAtMs: 0,
  nowMs: 0,
  maxWallClockMs: 60 * 60 * 1000,
};

// A critique that returns ready=true so iterate exits with "ready".
function makeReadyAdapter(): Adapter {
  const base = createFakeAdapter({});
  return {
    ...base,
    critique: () =>
      Promise.resolve({
        findings: [],
        summary: "all good",
        suggested_next_version: "1.0",
        usage: null,
        effort_used: "max",
      } satisfies CritiqueOutput),
    revise: (input) =>
      Promise.resolve({
        spec: input.spec,
        rationale: "no changes needed",
        ready: true,
        usage: null,
        effort_used: "max",
      }),
  };
}

describe("iterate next-step hints (#71)", () => {
  test("max-rounds stop -> stdout contains 'next: samospec publish'", async () => {
    seedSpec(tmp, SLUG);
    const lead = createFakeAdapter({});
    const res = await runIterate({
      cwd: tmp,
      slug: SLUG,
      now: NOW,
      resolvers: NO_OP_RESOLVERS,
      adapters: {
        lead,
        reviewerA: createFakeAdapter({}),
        reviewerB: createFakeAdapter({}),
      },
      maxRounds: 1,
      ...FAST_TIME,
    });
    expect(res.exitCode).toBe(0);
    const combined = res.stdout + res.stderr;
    expect(combined).toContain(`next: samospec publish ${SLUG}`);
  });

  test("ready stop -> stdout contains 'next: samospec publish'", async () => {
    seedSpec(tmp, SLUG);
    const readyAdapter = makeReadyAdapter();
    const res = await runIterate({
      cwd: tmp,
      slug: SLUG,
      now: NOW,
      resolvers: NO_OP_RESOLVERS,
      adapters: {
        lead: readyAdapter,
        reviewerA: createFakeAdapter({}),
        reviewerB: createFakeAdapter({}),
      },
      maxRounds: 5,
      ...FAST_TIME,
    });
    expect(res.exitCode).toBe(0);
    const combined = res.stdout + res.stderr;
    expect(combined).toContain(`next: samospec publish ${SLUG}`);
  });

  test("reviewers-exhausted -> recovery hint in output", async () => {
    seedSpec(tmp, SLUG);
    // Adapter that fails critiques so both seats exhaust.
    const failAdapter: Adapter = {
      ...createFakeAdapter({}),
      critique: () => Promise.reject(new Error("reviewer unavailable")),
    };
    const res = await runIterate({
      cwd: tmp,
      slug: SLUG,
      now: NOW,
      resolvers: {
        ...NO_OP_RESOLVERS,
        onReviewerExhausted: () => Promise.resolve("abort"),
      },
      adapters: {
        lead: createFakeAdapter({}),
        reviewerA: failAdapter,
        reviewerB: failAdapter,
      },
      maxRounds: 1,
      ...FAST_TIME,
    });
    // reviewers-exhausted exit code is 1.
    expect(res.exitCode).not.toBe(0);
    const combined = res.stdout + res.stderr;
    // Should contain some recovery/retry instruction.
    expect(combined).toMatch(/retry|resume|iterate/i);
  });
});
