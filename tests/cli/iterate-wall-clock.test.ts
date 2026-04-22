// Copyright 2026 Nikolay Samokhvalov.

// RED test for #91: iterate: --max-session-wall-clock-ms silently ignored.
//
// samospec new honors --max-session-wall-clock-ms; samospec iterate drops
// the flag because the parser has no branch for it AND runIterate doesn't
// accept a maxSessionWallClockMs field. Live-repro: flag set to 40min,
// iterate ran 1h 41m before needing manual kill.
//
// Two test layers:
//
// 1. Parser layer (src/cli.ts `parseIterateArgs`): the flag must be
//    accepted in both space-separated and `=value` forms. Unknown flags
//    like `--rouns 5` (typo of `--rounds 5`) must be rejected with exit
//    1 and "unknown flag" in stderr instead of silently dropped.
//
// 2. Runtime layer (src/cli/iterate.ts `runIterate`): with a mock
//    adapter that hangs on `critique`, runIterate must exit 4 within
//    ~2× the cap when maxSessionWallClockMs is honored, with
//    `session-wall-clock` in stderr.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCli } from "../../src/cli.ts";
import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type {
  Adapter,
  CritiqueInput,
  CritiqueOutput,
} from "../../src/adapter/types.ts";
import { runIterate, type IterateResolvers } from "../../src/cli/iterate.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-iter-wc-"));
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
  spawnSync("git", ["checkout", "-q", "-b", "samospec/wc-slug"], { cwd });
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
      persona: 'Veteran "wc-slug" expert',
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
    persona: { skill: "wc-slug", accepted: true },
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
  spawnSync("git", ["commit", "-q", "-m", "spec(wc-slug): draft v0.1"], {
    cwd,
  });
}

const ACCEPT_RESOLVERS: IterateResolvers = {
  onManualEdit: () => Promise.resolve("incorporate"),
  onDegraded: () => Promise.resolve("accept"),
  onReviewerExhausted: () => Promise.resolve("abort"),
};

// ---------- 1. Parser: flag accepted ----------

describe("iterate parser — --max-session-wall-clock-ms accepted (#91)", () => {
  test("no state seeded, so the run fails at the state-missing precondition, but parsing does not", async () => {
    // Parser must ACCEPT --max-session-wall-clock-ms. We feed a
    // non-existent slug so the run aborts at the state-missing gate
    // (exit 1, "no spec found") instead of mid-loop — that's fine for
    // this test; we only care the parser did not reject the flag.
    const res = await runCli([
      "iterate",
      "missing-slug",
      "--max-session-wall-clock-ms",
      "5000",
    ]);
    // Must NOT be the parser-failed path ("samospec iterate: missing
    // <slug>" / usage echo). Exit 1 from runIterate's state precondition
    // surfaces "no spec found" in stderr — proves we reached runIterate.
    expect(res.stderr.toLowerCase()).toContain("no spec found");
    expect(res.exitCode).toBe(1);
  });

  test("equals form --max-session-wall-clock-ms=5000 also accepted", async () => {
    const res = await runCli([
      "iterate",
      "missing-slug",
      "--max-session-wall-clock-ms=5000",
    ]);
    expect(res.stderr.toLowerCase()).toContain("no spec found");
    expect(res.exitCode).toBe(1);
  });

  test("non-integer value rejected with exit 1 + flag name in stderr", async () => {
    const res = await runCli([
      "iterate",
      "missing-slug",
      "--max-session-wall-clock-ms",
      "not-a-number",
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr.toLowerCase()).toContain("max-session-wall-clock-ms");
  });
});

// ---------- 2. Parser: unknown flag rejected (typo guard) ----------

describe("iterate parser — unknown --flag rejected (#91)", () => {
  test("--rouns 5 (typo of --rounds) rejected with exit 1 + 'unknown flag' in stderr", async () => {
    const res = await runCli(["iterate", "some-slug", "--rouns", "5"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr.toLowerCase()).toContain("unknown flag");
  });

  test("bare unknown --foo rejected with exit 1 + 'unknown flag' in stderr", async () => {
    const res = await runCli(["iterate", "some-slug", "--foo"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr.toLowerCase()).toContain("unknown flag");
  });

  test("known flags --rounds, --no-push, --remote, --quiet still accepted", async () => {
    const res = await runCli([
      "iterate",
      "missing-slug",
      "--rounds",
      "1",
      "--no-push",
      "--remote",
      "origin",
      "--quiet",
    ]);
    // These are valid flags — parser must not reject. Run falls through
    // to runIterate's missing-spec gate.
    expect(res.stderr.toLowerCase()).toContain("no spec found");
    expect(res.exitCode).toBe(1);
  });
});

// ---------- 3. Runtime: hanging reviewer honors the cap ----------

function makeHangingCritiqueAdapter(): Adapter {
  const base = createFakeAdapter({});
  return {
    ...base,
    critique: (_input: CritiqueInput): Promise<CritiqueOutput> =>
      new Promise(() => {
        /* hangs forever */
      }),
  };
}

describe("runIterate — maxSessionWallClockMs caps a hanging round (#91)", () => {
  test("hanging critique is preempted; exit 4 within ~2x cap; stderr contains session-wall-clock", async () => {
    const slug = "wc-slug";
    seedSpec(tmp, slug);

    const lead = createFakeAdapter({
      revise: {
        spec: "# SPEC\n\nrevised\n",
        ready: true,
        rationale: "[]",
        usage: null,
        effort_used: "max",
      },
    });
    const reviewerA = makeHangingCritiqueAdapter();
    const reviewerB = makeHangingCritiqueAdapter();

    const capMs = 2_000;
    const startMs = Date.now();
    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: { lead, reviewerA, reviewerB },
      maxRounds: 1,
      // The hanging reviewer must be preempted by the session
      // wall-clock guard, not by the per-call CRITIQUE_TIMEOUT_MS
      // (which defaults to 300s — way past test timeout).
      maxSessionWallClockMs: capMs,
      // Pin SPEC §11's "one more round fits" gate to a neutral state
      // so the new session-wall-clock cap (not the §11 gate) is what
      // preempts. Without these, `now_ms - session_started_at_ms` runs
      // off the `now` string vs real wall-clock and can trip §11 first.
      sessionStartedAtMs: 0,
      nowMs: 0,
      maxWallClockMs: 60 * 60 * 1000,
    });
    const elapsedMs = Date.now() - startMs;

    // Must terminate within ~2x the cap (generous allowance for
    // cleanup + finalize commit + subprocess overhead).
    expect(elapsedMs).toBeLessThan(capMs * 2 + 4_000);
    expect(res.exitCode).toBe(4);
    expect(res.stderr.toLowerCase()).toContain("session-wall-clock");
  }, 15_000);

  test("runIterate accepts maxSessionWallClockMs without throwing when all calls complete fast", async () => {
    const slug = "wc-slug";
    seedSpec(tmp, slug);

    const lead = createFakeAdapter({
      revise: {
        spec: "# SPEC\n\nrevised fast\n",
        ready: true,
        rationale: "[]",
        usage: null,
        effort_used: "max",
      },
    });
    const crit: CritiqueOutput = {
      findings: [],
      summary: "none",
      suggested_next_version: "0.2",
      usage: null,
      effort_used: "max",
    };
    const reviewerA = createFakeAdapter({ critique: crit });
    const reviewerB = createFakeAdapter({ critique: crit });

    // Generous cap — the fake-adapter round completes in milliseconds.
    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: { lead, reviewerA, reviewerB },
      maxRounds: 5,
      maxSessionWallClockMs: 60_000,
      // Explicit time inputs keep the pre-round shouldStartNextRound
      // check from firing; see iterate.test.ts DEFAULT_TIME_INPUTS.
      sessionStartedAtMs: 0,
      nowMs: 0,
      maxWallClockMs: 60 * 60 * 1000,
    });

    expect(res.exitCode).toBe(0);
    expect(res.stopReason).toBe("ready");
  }, 15_000);
});
