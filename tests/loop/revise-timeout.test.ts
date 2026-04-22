// Copyright 2026 Nikolay Samokhvalov.

// RED test for #92: the lead's `revise()` call must be capped by a
// per-call timeout at the round-runner level. When revise hangs past
// the configured timeout, runRound must:
//
//   1. Preempt the hung revise within ~1.5x the configured timeout.
//   2. Retry the whole round once (reviewers + revise).
//   3. If the retry also times out, return roundStopReason=lead_terminal
//      with a leadTerminalError whose message surfaces "revise timeout"
//      (so classifyLeadTerminal -> lead-terminal:revise_timeout and
//      iterate writes state.json.exit.reason accordingly).
//
// A separate iterate-level assertion verifies state.json.exit.reason.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  Adapter,
  AskInput,
  AskOutput,
  AuthStatus,
  CritiqueInput,
  CritiqueOutput,
  DetectResult,
  EffortLevel,
  ModelInfo,
  ReviseInput,
  ReviseOutput,
} from "../../src/adapter/types.ts";
import { roundDirsFor, runRound } from "../../src/loop/round.ts";
import { runIterate } from "../../src/cli/iterate.ts";
import { writeState, newState } from "../../src/state/store.ts";
import { runInit } from "../../src/cli/init.ts";

// ---------- test fixtures ----------

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

function passingReviewer(): Adapter {
  return {
    vendor: "fake-reviewer",
    detect: (): Promise<DetectResult> =>
      Promise.resolve({ installed: true, version: "0", path: "/fake" }),
    auth_status: (): Promise<AuthStatus> =>
      Promise.resolve({ authenticated: true }),
    supports_structured_output: () => true,
    supports_effort: (_: EffortLevel) => true,
    models: (): Promise<readonly ModelInfo[]> =>
      Promise.resolve([{ id: "fake", family: "fake" }]),
    ask: (_i: AskInput): Promise<AskOutput> =>
      Promise.reject(new Error("ask not used")),
    critique: (_i: CritiqueInput): Promise<CritiqueOutput> =>
      Promise.resolve(SAMPLE_CRITIQUE),
    revise: (_i: ReviseInput): Promise<ReviseOutput> =>
      Promise.reject(new Error("revise not used on reviewer seat")),
  };
}

/**
 * Lead adapter whose `revise()` hangs indefinitely (10 minutes — well
 * past any reasonable test timeout). Ships a counter on the returned
 * adapter so tests can assert retry behavior.
 */
function hangingLead(): Adapter & { reviseCalls: () => number } {
  let calls = 0;
  const adapter: Adapter = {
    vendor: "fake-lead-hang",
    detect: (): Promise<DetectResult> =>
      Promise.resolve({ installed: true, version: "0", path: "/fake" }),
    auth_status: (): Promise<AuthStatus> =>
      Promise.resolve({ authenticated: true }),
    supports_structured_output: () => true,
    supports_effort: (_: EffortLevel) => true,
    models: (): Promise<readonly ModelInfo[]> =>
      Promise.resolve([{ id: "fake", family: "fake" }]),
    ask: (_i: AskInput): Promise<AskOutput> =>
      Promise.reject(new Error("ask not used")),
    critique: (_i: CritiqueInput): Promise<CritiqueOutput> =>
      Promise.reject(new Error("critique not used on lead")),
    revise: (_i: ReviseInput): Promise<ReviseOutput> => {
      calls += 1;
      // Hangs forever. A 10-minute delay far exceeds any reasonable
      // test wall-clock, so the per-call timeout must preempt this.
      return new Promise(() => {
        /* never resolves */
      });
    },
  };
  return Object.assign(adapter, { reviseCalls: () => calls });
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-revise-timeout-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------- round-level tests ----------

describe("loop/round — lead revise per-call timeout (#92)", () => {
  test("revise timeout fires within ~1.5x the configured timeout", async () => {
    const lead = hangingLead();
    const revA = passingReviewer();
    const revB = passingReviewer();

    const dirs = roundDirsFor(tmp, 1);
    const reviseTimeoutMs = 200;
    const startMs = Date.now();

    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
      critiqueTimeoutMs: 5_000,
      reviseTimeoutMs,
    });
    const elapsedMs = Date.now() - startMs;

    // Budget: two revise attempts at 200ms each, plus reviewer fan-out
    // overhead. Generous ceiling catches the "hang forever" regression.
    expect(elapsedMs).toBeLessThan(reviseTimeoutMs * 6);
    // Both attempts should have timed out → lead_terminal.
    expect(outcome.roundStopReason).toBe("lead_terminal");
  });

  test("on revise timeout, runRound retries revise once (whole-round retry)", async () => {
    const lead = hangingLead();
    const revA = passingReviewer();
    const revB = passingReviewer();

    const dirs = roundDirsFor(tmp, 1);
    await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
      critiqueTimeoutMs: 5_000,
      reviseTimeoutMs: 200,
    });

    // First attempt + one retry = exactly 2 revise() invocations.
    expect(lead.reviseCalls()).toBe(2);
  });

  test("retry also times out → roundStopReason=lead_terminal, retried=true", async () => {
    const lead = hangingLead();
    const revA = passingReviewer();
    const revB = passingReviewer();

    const dirs = roundDirsFor(tmp, 1);
    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
      critiqueTimeoutMs: 5_000,
      reviseTimeoutMs: 200,
    });
    expect(outcome.roundStopReason).toBe("lead_terminal");
    expect(outcome.retried).toBe(true);
    // leadTerminalError should carry the revise-timeout signal so
    // classifyLeadTerminal can label the sub-reason distinctly.
    const errMsg =
      outcome.leadTerminalError instanceof Error
        ? outcome.leadTerminalError.message
        : String(outcome.leadTerminalError);
    expect(errMsg.toLowerCase()).toContain("revise");
    expect(errMsg.toLowerCase()).toContain("timeout");
  });

  test("revise succeeds on retry → roundStopReason=ok, retried=true", async () => {
    const revA = passingReviewer();
    const revB = passingReviewer();

    // Lead that hangs on the first revise() call, then succeeds on the
    // second. Demonstrates that the retry path actually lets a slow
    // adapter recover.
    let calls = 0;
    const lead: Adapter = {
      vendor: "fake-lead-flaky",
      detect: () =>
        Promise.resolve({ installed: true, version: "0", path: "/fake" }),
      auth_status: () => Promise.resolve({ authenticated: true }),
      supports_structured_output: () => true,
      supports_effort: () => true,
      models: () => Promise.resolve([{ id: "fake", family: "fake" }]),
      ask: () => Promise.reject(new Error("ask not used")),
      critique: () => Promise.reject(new Error("critique not used on lead")),
      revise: (_i: ReviseInput): Promise<ReviseOutput> => {
        calls += 1;
        if (calls === 1) {
          return new Promise(() => {
            /* never resolves */
          });
        }
        return Promise.resolve({
          spec: "# SPEC\n\nretry-succeeded body",
          ready: true,
          rationale: "retry ok",
          usage: null,
          effort_used: "max",
        });
      },
    };

    const dirs = roundDirsFor(tmp, 1);
    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
      critiqueTimeoutMs: 5_000,
      reviseTimeoutMs: 200,
    });
    expect(outcome.roundStopReason).toBe("ok");
    expect(outcome.retried).toBe(true);
    expect(outcome.revisedSpec).toContain("retry-succeeded body");
    expect(calls).toBe(2);
  });
});

// ---------- iterate-level integration test ----------

describe("iterate — revise timeout propagates to state.json.exit.reason (#92)", () => {
  test("hanging lead → state.json.exit.reason starts with lead-terminal", async () => {
    // Set up a minimal slug directory with state.json + SPEC.md so
    // runIterate reads them.
    runInit({ cwd: tmp });
    const slug = "demo";
    const slugDir = path.join(tmp, ".samo", "spec", slug);
    // Seed state + SPEC.md so iterate can start a round immediately.
    const seeded = {
      ...newState({ slug, now: "2026-04-19T12:00:00Z" }),
      phase: "review_loop" as const,
      round_state: "committed" as const,
      version: "0.1.0",
    };
    // mkdir happens inside newState? No — we need the dir ourselves.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(slugDir, { recursive: true });
    writeState(path.join(slugDir, "state.json"), seeded);
    writeFileSync(path.join(slugDir, "SPEC.md"), "# SPEC\n\nbody\n", "utf8");
    writeFileSync(
      path.join(slugDir, "decisions.md"),
      "# decisions\n\n- none.\n",
      "utf8",
    );
    writeFileSync(
      path.join(slugDir, "changelog.md"),
      "# changelog\n\n- v0.1\n",
      "utf8",
    );

    // Also: init a git repo so branch ops don't explode.
    const { spawnSync } = await import("node:child_process");
    spawnSync("git", ["init", "-b", "main"], { cwd: tmp });
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: tmp,
    });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: tmp });
    spawnSync("git", ["add", "."], { cwd: tmp });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: tmp });
    spawnSync("git", ["checkout", "-b", `samospec/${slug}`], { cwd: tmp });

    const lead = hangingLead();
    const revA = passingReviewer();
    const revB = passingReviewer();

    const startMs = Date.now();
    const nowIso = new Date(startMs).toISOString();
    const result = await runIterate({
      cwd: tmp,
      slug,
      now: nowIso,
      resolvers: {
        onManualEdit: () => Promise.resolve("incorporate"),
        onDegraded: () => Promise.resolve("accept"),
        onReviewerExhausted: () => Promise.resolve("abort"),
      },
      adapters: { lead, reviewerA: revA, reviewerB: revB },
      maxRounds: 1,
      // Use `sessionStartedAtMs` so the wall-clock guard doesn't halt
      // the loop before runRound even begins: without this, the test's
      // `now` (ISO string) minus `Date.now()` yields a huge elapsed
      // value that immediately trips the wall-clock budget.
      sessionStartedAtMs: startMs,
      callTimeouts: {
        criticA_ms: 5_000,
        criticB_ms: 5_000,
        revise_ms: 300,
      },
    });
    const elapsedMs = Date.now() - startMs;

    // Must NOT run forever — with 300ms revise + one retry, total ~1s.
    expect(elapsedMs).toBeLessThan(10_000);
    expect(result.exitCode).toBe(4);

    // state.json.exit.reason must be set on disk and start with
    // "lead-terminal" (SPEC §7 sub-reason classifier).
    const statePath = path.join(slugDir, "state.json");
    expect(existsSync(statePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      exit?: { reason?: string } | null;
      round_state?: string;
    };
    expect(persisted.exit).toBeDefined();
    expect(persisted.exit?.reason).toBeDefined();
    // Sub-reason is `revise_timeout` per the classifier in
    // src/cli/terminal-messages.ts.
    expect(persisted.exit?.reason).toBe("lead-terminal:revise_timeout");
    expect(persisted.round_state).toBe("lead_terminal");
  }, 30_000);
});
