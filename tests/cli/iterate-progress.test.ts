// Copyright 2026 Nikolay Samokhvalov.

/**
 * Issue #101 — `samospec iterate` must emit per-phase progress and a
 * heartbeat to stderr while a round is running so operators can tell
 * "working" from "hung". Stdout keeps its existing final-summary lines
 * untouched (scripts parsing stdout must not break).
 *
 * The tests drive runIterate with a slow, deterministic stub clock + a
 * stub scheduler that lets us manually "tick" time forward. No real
 * wall-clock dependency.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  Adapter,
  CritiqueInput,
  CritiqueOutput,
  ReviseInput,
  ReviseOutput,
} from "../../src/adapter/types.ts";
import { runIterate, type IterateResolvers } from "../../src/cli/iterate.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-iterate-progress-"));
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
  return state;
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

const SAMPLE_CRITIQUE: CritiqueOutput = {
  findings: [
    { category: "ambiguity", text: "ambiguous", severity: "minor" },
    {
      category: "missing-requirement",
      text: "missing something",
      severity: "major",
    },
  ],
  summary: "two findings",
  suggested_next_version: "0.2",
  usage: null,
  effort_used: "max",
};

const SAMPLE_REVISE: ReviseOutput = {
  spec: "# SPEC\n\ncontent v0.2 revised\n",
  ready: true,
  rationale: "[]",
  usage: null,
  effort_used: "max",
};

/**
 * Deterministic clock + scheduler pair so the runIterate progress test
 * can drive "heartbeat fires after 30s" without real sleeps.
 */
interface StubClock {
  now(): number;
  advance(ms: number): void;
}

interface StubScheduler {
  /**
   * Start an interval. The implementation must call `cb` each time
   * `clock.advance()` moves past the next multiple of `intervalMs`.
   * Returns a cancel handle.
   */
  schedule(cb: () => void, intervalMs: number): { cancel: () => void };
  tick(): void;
}

function makeStubClockAndScheduler(): {
  clock: StubClock;
  scheduler: StubScheduler;
} {
  let nowMs = 0;
  interface Entry {
    cb: () => void;
    intervalMs: number;
    nextFireAt: number;
    cancelled: boolean;
  }
  const entries: Entry[] = [];
  const clock: StubClock = {
    now: () => nowMs,
    advance: (ms: number) => {
      const target = nowMs + ms;
      // Fire each scheduled callback for every interval boundary we cross.
      // Loop until the active entries are all past the target.
      while (true) {
        const live = entries.filter((e) => !e.cancelled);
        if (live.length === 0) break;
        const next = live
          .map((e) => e.nextFireAt)
          .reduce((a, b) => (a < b ? a : b));
        if (next > target) break;
        nowMs = next;
        for (const e of entries) {
          if (!e.cancelled && e.nextFireAt === next) {
            e.cb();
            e.nextFireAt += e.intervalMs;
          }
        }
      }
      nowMs = target;
    },
  };
  const scheduler: StubScheduler = {
    schedule(cb, intervalMs) {
      const entry: Entry = {
        cb,
        intervalMs,
        nextFireAt: nowMs + intervalMs,
        cancelled: false,
      };
      entries.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
    tick() {
      // Convenience helper — advance by zero, flush anything pending.
      clock.advance(0);
    },
  };
  return { clock, scheduler };
}

/**
 * Build a slow adapter whose `critique` / `revise` resolve only after
 * the stub clock advances past `delayMs`. We do this with a polling
 * setTimeout on the microtask queue so the scheduler's heartbeat can
 * fire during the wait.
 */
function slowAdapter(
  vendor: string,
  delayMs: number,
  clock: StubClock,
  critiqueOut: CritiqueOutput,
  reviseOut: ReviseOutput,
  steps: StubScheduler,
): Adapter {
  const waitUntil = (
    startMs: number,
  ): Promise<void> =>
    new Promise((resolve) => {
      const poll = (): void => {
        if (clock.now() - startMs >= delayMs) {
          resolve();
          return;
        }
        // Yield to the test so it can advance the clock.
        setImmediate(poll);
      };
      poll();
    });
  return {
    vendor,
    detect: () =>
      Promise.resolve({ installed: true, version: "x", path: "/x" }),
    auth_status: () => Promise.resolve({ authenticated: true }),
    supports_structured_output: () => true,
    supports_effort: () => true,
    models: () => Promise.resolve([{ id: `${vendor}-max`, family: vendor }]),
    ask: () => Promise.reject(new Error("unused")),
    critique: async (_input: CritiqueInput) => {
      const startedAt = clock.now();
      await waitUntil(startedAt);
      steps.tick();
      return critiqueOut;
    },
    revise: async (_input: ReviseInput) => {
      const startedAt = clock.now();
      await waitUntil(startedAt);
      steps.tick();
      return reviseOut;
    },
  };
}

/**
 * Drive the stub clock forward while `runIterate` is awaiting adapter
 * calls. Runs concurrently with the runIterate promise so the test
 * can advance simulated time without blocking on real wall-clock.
 */
async function driveClock(
  clock: StubClock,
  scheduler: StubScheduler,
  totalMs: number,
  stepMs: number,
): Promise<void> {
  let advanced = 0;
  while (advanced < totalMs) {
    // Let any outstanding microtasks run so the slow-adapter poll can
    // check the clock between advances.
    await new Promise((r) => setImmediate(r));
    clock.advance(stepMs);
    scheduler.tick();
    advanced += stepMs;
  }
}

describe("cli/iterate — progress + heartbeat (#101)", () => {
  test("emits round-start, per-phase, heartbeat on stderr; stdout unchanged", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);

    const { clock, scheduler } = makeStubClockAndScheduler();

    // Each phase takes 90s of fake time. Heartbeat = 30s. So each phase
    // should trigger at least 2 heartbeat firings.
    const PHASE_MS = 90_000;
    const lead = slowAdapter(
      "claude",
      PHASE_MS,
      clock,
      SAMPLE_CRITIQUE,
      SAMPLE_REVISE,
      scheduler,
    );
    const revA = slowAdapter(
      "codex",
      PHASE_MS,
      clock,
      SAMPLE_CRITIQUE,
      SAMPLE_REVISE,
      scheduler,
    );
    const revB = slowAdapter(
      "claude",
      PHASE_MS,
      clock,
      SAMPLE_CRITIQUE,
      SAMPLE_REVISE,
      scheduler,
    );

    const iteratePromise = runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: { lead, reviewerA: revA, reviewerB: revB },
      maxRounds: 1,
      ...DEFAULT_TIME_INPUTS,
      progress: {
        clock: { now: () => clock.now() },
        heartbeatIntervalMs: 30_000,
        schedule: (cb, ms) => scheduler.schedule(cb, ms),
      },
    });

    // Drive 600s of fake time in 1s steps — enough for both phases.
    await driveClock(clock, scheduler, 600_000, 1_000);
    const res = await iteratePromise;

    expect(res.exitCode).toBe(0);

    // --- stderr assertions ---
    const err = res.stderr;

    // (a) Round-start line.
    expect(err).toContain("round 1 starting");

    // (b) Per-phase start/complete lines with identity + duration.
    // Reviewers A + B run in parallel.
    expect(err).toMatch(/reviewer A \(codex\) starting/);
    expect(err).toMatch(/reviewer A complete \(\d+s, \d+ findings\)/);
    expect(err).toMatch(/reviewer B \(claude\) starting/);
    expect(err).toMatch(/reviewer B complete \(\d+s, \d+ findings\)/);
    expect(err).toMatch(/lead revise starting/);
    expect(err).toMatch(/lead revise complete \(\d+s\)/);

    // (c) At least one heartbeat line. Format: "<child> (<model>) — <N>s"
    // The heartbeat must identify the active child.
    expect(err).toMatch(/— \d+s$/m);

    // (d) Stdout still carries the existing final-summary lines.
    expect(res.stdout).toContain("committed spec(refunds)");
    expect(res.stdout).toContain("next:");

    // (e) Stdout NOT polluted with progress or heartbeat.
    expect(res.stdout).not.toContain("round 1 starting");
    expect(res.stdout).not.toMatch(/— \d+s/);
    expect(res.stdout).not.toContain("reviewer A starting");
    expect(res.stdout).not.toContain("lead revise starting");
  });

  test("--quiet suppresses progress + heartbeat; final summary still on stdout", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);

    const { clock, scheduler } = makeStubClockAndScheduler();
    const PHASE_MS = 90_000;
    const lead = slowAdapter(
      "claude",
      PHASE_MS,
      clock,
      SAMPLE_CRITIQUE,
      SAMPLE_REVISE,
      scheduler,
    );
    const revA = slowAdapter(
      "codex",
      PHASE_MS,
      clock,
      SAMPLE_CRITIQUE,
      SAMPLE_REVISE,
      scheduler,
    );
    const revB = slowAdapter(
      "claude",
      PHASE_MS,
      clock,
      SAMPLE_CRITIQUE,
      SAMPLE_REVISE,
      scheduler,
    );

    const iteratePromise = runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: { lead, reviewerA: revA, reviewerB: revB },
      maxRounds: 1,
      quiet: true,
      ...DEFAULT_TIME_INPUTS,
      progress: {
        clock: { now: () => clock.now() },
        heartbeatIntervalMs: 30_000,
        schedule: (cb, ms) => scheduler.schedule(cb, ms),
      },
    });

    await driveClock(clock, scheduler, 600_000, 1_000);
    const res = await iteratePromise;

    expect(res.exitCode).toBe(0);

    // No progress or heartbeat lines on either stream.
    expect(res.stderr).not.toContain("round 1 starting");
    expect(res.stderr).not.toContain("reviewer A (codex) starting");
    expect(res.stderr).not.toContain("lead revise starting");
    expect(res.stderr).not.toMatch(/— \d+s/);
    expect(res.stdout).not.toContain("round 1 starting");
    expect(res.stdout).not.toMatch(/— \d+s/);

    // Final summary still on stdout.
    expect(res.stdout).toContain("committed spec(refunds)");
    expect(res.stdout).toContain("next:");
  });
});
