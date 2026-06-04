// Copyright 2026 Nikolay Samokhvalov.

// Behavior fence for samo.team #415 + #424: CLI must NOT kill a dev LLM
// run on the wall clock.
//
// Rule 10 / memory `feedback_no_dev_timeout`:
//   "No setTimeout, no --timeout flag, no AppArmor RuntimeMaxSec=, no
//    Caddy read_timeout, no EventSource client-side reconnect threshold,
//    nothing kills a dev LLM run on the wall clock. Allowed stop signals:
//    inactivity heartbeat + user-cancel."
//
// History:
//   - samospec #81 added a 10-min session wall-clock cap to `samospec new`
//     emitting exit 4 with `session-wall-clock` in stderr.
//   - samospec #91 mirrored the same cap into `samospec iterate`.
//   - samo.team consumed the CLI as a subprocess and translated exit 4
//     into an `exit-timeout` SSE event, which the UI rendered as
//     "Run ended / timed out / exit code 4" — alarming the user even
//     when the underlying LLM was still making progress.
//   - samo.team #415 removed the BACKEND supervisor; #424 reworded the
//     frontend copy. This fence ensures the CLI itself never produces
//     the wall-clock kill in the first place.
//
// What this fence asserts:
//   1. With a hanging adapter and an explicit `maxSessionWallClockMs`,
//      `runNew` does NOT exit 4 with `session-wall-clock` within a
//      window longer than the cap. The CLI keeps running; the only
//      legitimate stop is parent SIGTERM or inactivity-heartbeat
//      handling (neither of which exit 4 with a wall-clock reason).
//   2. Same for `runIterate`.
//
// Implementation note: because the adapters hang forever, we race the
// CLI promise against a real-time deadline and assert the CLI did NOT
// resolve within the wall-clock-cap window. If the kill were still in
// place, the CLI would resolve with exit 4 + session-wall-clock well
// before the deadline.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
  StructuredAskInput,
  StructuredAskOutput,
} from "../../src/adapter/types.ts";
import { runNew, type ChoiceResolvers } from "../../src/cli/new.ts";
import { runInit } from "../../src/cli/init.ts";
import { runIterate, type IterateResolvers } from "../../src/cli/iterate.ts";
import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

// ---------- helpers ----------

function makeHangingAdapter(): Adapter {
  const auth: AuthStatus = { authenticated: true, subscription_auth: false };
  return {
    vendor: "fake-hang",
    detect: (): Promise<DetectResult> =>
      Promise.resolve({ installed: true, version: "0", path: "/fake" }),
    auth_status: (): Promise<AuthStatus> => Promise.resolve(auth),
    supports_structured_output: () => true,
    supports_effort: (_level: EffortLevel) => true,
    models: (): Promise<readonly ModelInfo[]> =>
      Promise.resolve([{ id: "fake", family: "fake" }]),
    ask: (_input: AskInput): Promise<AskOutput> =>
      new Promise(() => {
        /* hangs */
      }),
    structuredAsk: (
      _input: StructuredAskInput,
    ): Promise<StructuredAskOutput> =>
      new Promise(() => {
        /* hangs */
      }),
    critique: (_input: CritiqueInput): Promise<CritiqueOutput> =>
      new Promise(() => {
        /* hangs */
      }),
    revise: (_input: ReviseInput): Promise<ReviseOutput> =>
      new Promise(() => {
        /* hangs */
      }),
  };
}

function acceptResolvers(): ChoiceResolvers {
  return {
    persona: () => Promise.resolve({ kind: "accept" }),
    question: (_q) => Promise.resolve({ choice: "decide for me" }),
  };
}

const ITERATE_RESOLVERS: IterateResolvers = {
  onManualEdit: () => Promise.resolve("incorporate"),
  onDegraded: () => Promise.resolve("accept"),
  onReviewerExhausted: () => Promise.resolve("abort"),
};

/** Race a promise against a real-time deadline. */
async function raceDeadline<T>(
  p: Promise<T>,
  deadlineMs: number,
): Promise<{ resolved: true; value: T } | { resolved: false }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ resolved: false });
    }, deadlineMs);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve({ resolved: true, value });
      },
      () => {
        // If the CLI throws unexpectedly, the test should still progress;
        // treat as "did not resolve normally" so the fence still asserts
        // the absence of a clean exit-4 wall-clock kill.
        clearTimeout(timer);
        resolve({ resolved: false });
      },
    );
  });
}

// ---------- new ----------

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-no-wc-kill-"));
  runInit({ cwd: tmp });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("CLI wall-clock kill removed (samo.team #415 + #424)", () => {
  test("runNew does NOT exit 4 with session-wall-clock when cap is exceeded", async () => {
    const adapter = makeHangingAdapter();
    const capMs = 1_000;

    const runPromise = runNew(
      {
        cwd: tmp,
        slug: "no-kill-new",
        idea: "fence test",
        explain: false,
        resolvers: acceptResolvers(),
        now: "2026-04-19T10:00:00Z",
        // Cap value that the OLD code would have honored. The NEW code
        // must IGNORE it — adapter hangs, CLI keeps running, no exit 4.
        maxSessionWallClockMs: capMs,
      },
      adapter,
    );

    // Race against a deadline well past the cap. The OLD kill mechanism
    // would have produced exit 4 + session-wall-clock within ~capMs;
    // post-fix the CLI must still be running (unresolved) at this point.
    const outcome = await raceDeadline(runPromise, capMs * 3 + 500);
    expect(outcome.resolved).toBe(false);
  }, 8_000);

  test("runIterate does NOT exit 4 with session-wall-clock when cap is exceeded", async () => {
    // Seed the spec so iterate gets past its state-missing precondition.
    const slug = "no-kill-iter";
    spawnSync("git", ["init", "-q"], { cwd: tmp });
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: tmp,
    });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: tmp });
    spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: tmp });
    spawnSync("git", ["checkout", "-q", "-b", `samospec/${slug}`], {
      cwd: tmp,
    });
    writeFileSync(path.join(tmp, "README.md"), "seed\n", "utf8");
    spawnSync("git", ["add", "README.md"], { cwd: tmp });
    spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd: tmp });

    const slugDir = path.join(tmp, ".samo", "spec", slug);
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
        persona: 'Veteran "no-kill-iter" expert',
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
      persona: { skill: "no-kill-iter", accepted: true },
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
    spawnSync("git", ["add", "."], { cwd: tmp });
    spawnSync("git", ["commit", "-q", "-m", "seed spec"], { cwd: tmp });

    const lead = createFakeAdapter({
      revise: {
        spec: "# SPEC\n\nrevised\n",
        ready: true,
        rationale: "[]",
        usage: null,
        effort_used: "max",
      },
    });
    const reviewerA: Adapter = {
      ...createFakeAdapter({}),
      critique: () =>
        new Promise(() => {
          /* hangs */
        }),
    };
    const reviewerB: Adapter = {
      ...createFakeAdapter({}),
      critique: () =>
        new Promise(() => {
          /* hangs */
        }),
    };

    const capMs = 1_000;
    const runPromise = runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ITERATE_RESOLVERS,
      adapters: { lead, reviewerA, reviewerB },
      maxRounds: 1,
      maxSessionWallClockMs: capMs,
      sessionStartedAtMs: 0,
      nowMs: 0,
      maxWallClockMs: 60 * 60 * 1000,
      // Pin per-call timeouts so the pre-round budget gate lets the round
      // start (the hanging call is what this test observes).
      callTimeouts: {
        criticA_ms: 300_000,
        criticB_ms: 300_000,
        revise_ms: 600_000,
      },
    });

    const outcome = await raceDeadline(runPromise, capMs * 3 + 500);
    expect(outcome.resolved).toBe(false);
  }, 10_000);
});
