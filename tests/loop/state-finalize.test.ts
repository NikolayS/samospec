// Copyright 2026 Nikolay Samokhvalov.

/**
 * Issue #102 — iterate must leave the tree clean, populate `head_sha`, and
 * keep `updated_at` current across every state.json write.
 *
 * Red-first: three targeted assertions around a single converged run.
 *   A) `git status --porcelain` empty under `.samo/spec/<slug>/` after exit.
 *   B) `state.head_sha` is a 40-char SHA matching `git rev-parse HEAD`.
 *   C) `state.updated_at > state.created_at` and within 10s of wall-clock now.
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
import type { Adapter, CritiqueOutput } from "../../src/adapter/types.ts";
import { runIterate, type IterateResolvers } from "../../src/cli/iterate.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-state-finalize-"));
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

/** Seed matches the `tests/loop/e2e.test.ts` shape; kept local to stay
 *  decoupled from that test's exports. */
function seedSpec(cwd: string, slug: string, createdAt: string): void {
  const slugDir = path.join(cwd, ".samo", "spec", slug);
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(
    path.join(slugDir, "SPEC.md"),
    "# SPEC\n\nv0.1 body\n- initial requirement\n",
    "utf8",
  );
  writeFileSync(path.join(slugDir, "TLDR.md"), "# TLDR\n\n- stub\n", "utf8");
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
      persona: 'Veteran "refunds" expert',
      generated_at: createdAt,
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
    created_at: createdAt,
    updated_at: createdAt,
  };
  writeState(path.join(slugDir, "state.json"), state);
  spawnSync("git", ["add", "."], { cwd });
  spawnSync("git", ["commit", "-q", "-m", "spec(refunds): draft v0.1"], {
    cwd,
  });
}

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

function buildCritique(suffix: number): CritiqueOutput {
  return {
    findings: [
      {
        category: "ambiguity",
        text: `finding #${String(suffix)} in spec body`,
        severity: "minor",
      },
    ],
    summary: `round ${String(suffix)} summary`,
    suggested_next_version: `0.${String(suffix + 1)}`,
    usage: null,
    effort_used: "max",
  };
}

/** Converges in one round via `ready=true`. */
async function runOneRoundConverged(args: {
  readonly cwd: string;
  readonly slug: string;
  readonly now: string;
}): Promise<void> {
  const lead: Adapter = createFakeAdapter({
    revise: {
      spec: "# SPEC\n\nrevised body\n- item\n",
      ready: true,
      rationale: "[]",
      usage: null,
      effort_used: "max",
    },
  });
  const critiqueAdapter = createFakeAdapter({ critique: buildCritique(1) });

  const res = await runIterate({
    cwd: args.cwd,
    slug: args.slug,
    now: args.now,
    resolvers: ACCEPT_RESOLVERS,
    adapters: {
      lead,
      reviewerA: critiqueAdapter,
      reviewerB: critiqueAdapter,
    },
    maxRounds: 3,
    ...DEFAULT_TIME_INPUTS,
  });
  expect(res.exitCode).toBe(0);
  expect(res.stopReason).toBe("ready");
}

/**
 * Drives iterate to a `lead_terminal` exit (exit 4) by replacing the lead
 * adapter's `revise()` with a reject. The rest of the round is otherwise
 * a normal one-round loop; both reviewers succeed.
 */
async function runOneRoundLeadTerminal(args: {
  readonly cwd: string;
  readonly slug: string;
  readonly now: string;
}): Promise<void> {
  const base = createFakeAdapter({});
  const lead: Adapter = {
    ...base,
    // Throw a plain Error so the SPEC §7 sub-reason classifier falls
    // back to `adapter_error` — the exact bucket is not load-bearing
    // for this test, only that the lead_terminal path is taken.
    revise: () => Promise.reject(new Error("synthetic lead failure for test")),
  };
  const critiqueAdapter = createFakeAdapter({ critique: buildCritique(1) });

  const res = await runIterate({
    cwd: args.cwd,
    slug: args.slug,
    now: args.now,
    resolvers: ACCEPT_RESOLVERS,
    adapters: {
      lead,
      reviewerA: critiqueAdapter,
      reviewerB: critiqueAdapter,
    },
    maxRounds: 3,
    ...DEFAULT_TIME_INPUTS,
  });
  expect(res.exitCode).toBe(4);
}

describe("loop/state-finalize — iterate bookkeeping (#102)", () => {
  test("A: working tree is clean after a converged run", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug, "2026-04-19T12:00:00Z");
    await runOneRoundConverged({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
    });

    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: tmp,
      encoding: "utf8",
    });
    expect(status.status).toBe(0);
    // The spec tree must be clean — no `M .samo/spec/<slug>/state.json`.
    expect(status.stdout).toBe("");
  });

  test("B: state.head_sha is a reachable 40-char SHA after exit", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug, "2026-04-19T12:00:00Z");
    await runOneRoundConverged({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
    });

    const statePath = path.join(tmp, ".samo", "spec", slug, "state.json");
    const state: State = JSON.parse(readFileSync(statePath, "utf8"));

    expect(state.head_sha).not.toBeNull();
    expect(state.head_sha).toMatch(/^[0-9a-f]{40}$/);

    // The finalize bookkeeping commit IS HEAD and cannot name itself in
    // its own state.json payload, so `state.head_sha` points to the
    // refine content commit (HEAD~1). Verify that: (1) the recorded
    // sha is reachable from HEAD, and (2) the current HEAD is either
    // that sha itself (no finalize commit path) or its direct child.
    const rev = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: tmp,
      encoding: "utf8",
    });
    const headSha = (rev.stdout ?? "").trim();
    const parent = spawnSync("git", ["rev-parse", "HEAD~1"], {
      cwd: tmp,
      encoding: "utf8",
    });
    const parentSha = (parent.stdout ?? "").trim();
    // Narrow: the preceding assertions guarantee `head_sha` is a non-
    // null 40-char hex string at this point; the optional-chain above
    // is only there because the Zod schema makes the field nullable.
    const recorded = state.head_sha ?? "";
    expect([headSha, parentSha]).toContain(recorded);
  });

  test("C: state.updated_at advances past created_at and tracks wall-clock", async () => {
    const slug = "refunds";
    const createdAt = "2026-04-19T12:00:00Z";
    seedSpec(tmp, slug, createdAt);

    // Pass the SAME round-start timestamp as `input.now`. Today the
    // iterate loop threads this value straight into every state.json
    // write, which is exactly the bug observation C calls out: the
    // stamp is "frozen at round start", never tracks wall-clock.
    //
    // After the fix, `updated_at` must be re-bumped to the current
    // wall-clock on the final write, so it will be newer than the
    // round-start stamp and within a few seconds of `Date.now()`.
    await runOneRoundConverged({ cwd: tmp, slug, now: createdAt });

    const statePath = path.join(tmp, ".samo", "spec", slug, "state.json");
    const state: State = JSON.parse(readFileSync(statePath, "utf8"));

    const createdMs = Date.parse(state.created_at);
    const updatedMs = Date.parse(state.updated_at);
    expect(updatedMs).toBeGreaterThan(createdMs);

    // Within 10s of wall-clock now — tolerates slow CI.
    const nowMs = Date.now();
    expect(Math.abs(nowMs - updatedMs)).toBeLessThan(10_000);
  });

  // Issue #102 — the `ready=true` happy-path test above covered the main
  // finalize seam. This block re-asserts the same three invariants for
  // the `lead_terminal` exit (exit code 4), which pre-fix bypassed
  // `finishIterate` via an early return and left state.json dirty.
  test("A (lead_terminal): working tree is clean after exit 4", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug, "2026-04-19T12:00:00Z");
    await runOneRoundLeadTerminal({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
    });

    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: tmp,
      encoding: "utf8",
    });
    expect(status.status).toBe(0);
    expect(status.stdout).toBe("");
  });

  test("B (lead_terminal): state.head_sha is a 40-char SHA after exit 4", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug, "2026-04-19T12:00:00Z");
    await runOneRoundLeadTerminal({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
    });

    const statePath = path.join(tmp, ".samo", "spec", slug, "state.json");
    const state: State = JSON.parse(readFileSync(statePath, "utf8"));

    expect(state.head_sha).not.toBeNull();
    expect(state.head_sha).toMatch(/^[0-9a-f]{40}$/);

    // The finalize bookkeeping commit is HEAD and cannot name itself in
    // its own payload, so the recorded sha is either HEAD (no finalize
    // commit — nothing to finalize) or HEAD~1 (finalize commit present).
    const rev = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: tmp,
      encoding: "utf8",
    });
    const headSha = (rev.stdout ?? "").trim();
    const parent = spawnSync("git", ["rev-parse", "HEAD~1"], {
      cwd: tmp,
      encoding: "utf8",
    });
    const parentSha = (parent.stdout ?? "").trim();
    const recorded = state.head_sha ?? "";
    expect([headSha, parentSha]).toContain(recorded);
  });

  test("C (lead_terminal): state.updated_at advances past created_at", async () => {
    const slug = "refunds";
    const createdAt = "2026-04-19T12:00:00Z";
    seedSpec(tmp, slug, createdAt);
    await runOneRoundLeadTerminal({ cwd: tmp, slug, now: createdAt });

    const statePath = path.join(tmp, ".samo", "spec", slug, "state.json");
    const state: State = JSON.parse(readFileSync(statePath, "utf8"));

    const createdMs = Date.parse(state.created_at);
    const updatedMs = Date.parse(state.updated_at);
    expect(updatedMs).toBeGreaterThan(createdMs);

    const nowMs = Date.now();
    expect(Math.abs(nowMs - updatedMs)).toBeLessThan(10_000);
  });
});
