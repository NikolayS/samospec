// Copyright 2026 Nikolay Samokhvalov.

// End-to-end coverage for the `samospec iterate` resume wiring of the
// "resumable-reviews" feature (src/cli/iterate.ts lines 327-377 +
// 658-701).
//
// The whole point of the feature is that a `lead_terminal` round is no
// longer a dead-end: when the failed round's reviewer critiques are
// persisted on disk, `runIterate` must
//   1. detect them,
//   2. emit the "retrying ... without re-running reviewers" notice,
//   3. clear the terminal state,
//   4. thread `reusedCritiques` into EXACTLY the failed round, and
//   5. recover (exit 0, commit the round) WITHOUT re-invoking — or
//      re-paying for — the reviewers.
//
// The pre-existing iterate test for `lead_terminal`
// (tests/cli/iterate.test.ts) seeds `round_state=lead_terminal` but
// writes NO critique files, so it only exercises the OLD
// `persisted === null` absorbing branch (exit 4). These tests seed
// `lead_terminal` WITH `codex.md` / `claude.md` on disk and assert the
// recovery branch instead.

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
import type {
  Adapter,
  CritiqueInput,
  CritiqueOutput,
  ReviseInput,
  ReviseOutput,
} from "../../src/adapter/types.ts";
import { runIterate, type IterateResolvers } from "../../src/cli/iterate.ts";
import { renderCritiqueMarkdown, roundDirsFor } from "../../src/loop/round.ts";
import { specSlugDir } from "../../src/paths.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-iterate-resume-"));
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

const ACCEPT_RESOLVERS: IterateResolvers = {
  onManualEdit: () => Promise.resolve("incorporate"),
  onDegraded: () => Promise.resolve("accept"),
  onReviewerExhausted: () => Promise.resolve("abort"),
};

const DEFAULT_TIME_INPUTS = {
  sessionStartedAtMs: 0,
  nowMs: 0,
  maxWallClockMs: 60 * 60 * 1000,
  callTimeouts: {
    criticA_ms: 300_000,
    criticB_ms: 300_000,
    revise_ms: 600_000,
  },
};

const CRIT_A: CritiqueOutput = {
  findings: [
    { category: "missing-risk", text: "no auth story", severity: "major" },
  ],
  summary: "reviewer A saved summary",
  suggested_next_version: "0.2",
  usage: null,
  effort_used: "max",
};

const CRIT_B: CritiqueOutput = {
  findings: [
    { category: "weak-implementation", text: "no tests", severity: "minor" },
  ],
  summary: "reviewer B saved summary",
  suggested_next_version: "0.2",
  usage: null,
  effort_used: "max",
};

/**
 * Seed a `review_loop` spec already at `lead_terminal` with the failed
 * round's reviewer critiques persisted to disk. `failedRound` defaults
 * to 1; `state.round_index` is `failedRound - 1` so the iterate loop's
 * first `roundIndex = round_index + 1` lands on the failed round.
 */
function seedLeadTerminalWithCritiques(
  cwd: string,
  slug: string,
  opts: {
    readonly failedRound?: number;
    readonly seatA?: CritiqueOutput | null;
    readonly seatB?: CritiqueOutput | null;
  } = {},
): { slugDir: string; failedRound: number } {
  const failedRound = opts.failedRound ?? 1;
  const seatA = opts.seatA === undefined ? CRIT_A : opts.seatA;
  const seatB = opts.seatB === undefined ? CRIT_B : opts.seatB;

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

  const state: State = {
    slug,
    phase: "review_loop",
    round_index: failedRound - 1,
    version: "0.1.0",
    persona: { skill: "refunds", accepted: true },
    push_consent: null,
    calibration: null,
    remote_stale: false,
    coupled_fallback: false,
    head_sha: null,
    round_state: "lead_terminal",
    exit: {
      code: 4,
      reason: "lead-terminal:revise_timeout",
      round_index: failedRound,
    },
    created_at: "2026-04-19T12:00:00Z",
    updated_at: "2026-04-19T12:00:00Z",
  };
  writeState(path.join(slugDir, "state.json"), state);

  // Persist the failed round's reviewer critiques exactly as runRound
  // would have written them before the lead's revise() timed out.
  const dirs = roundDirsFor(specSlugDir(cwd, slug), failedRound);
  mkdirSync(dirs.roundDir, { recursive: true });
  if (seatA !== null) {
    writeFileSync(
      dirs.codexPath,
      renderCritiqueMarkdown(seatA, "reviewer_a"),
      "utf8",
    );
  }
  if (seatB !== null) {
    writeFileSync(
      dirs.claudePath,
      renderCritiqueMarkdown(seatB, "reviewer_b"),
      "utf8",
    );
  }

  spawnSync("git", ["add", "."], { cwd });
  spawnSync("git", ["commit", "-q", "-m", "spec(refunds): lead_terminal"], {
    cwd,
  });
  return { slugDir, failedRound };
}

/** Reviewer adapter that EXPLODES if its critique() is ever invoked. */
function explodingReviewer(): Adapter {
  return {
    ...createFakeAdapter({}),
    critique: (_input: CritiqueInput) =>
      Promise.reject(
        new Error("reviewer must NOT be invoked on the resume path"),
      ),
  };
}

describe("cli/iterate — resume from lead_terminal WITH saved critiques", () => {
  test("recovers the failed round: exit 0, reviewers never invoked, round committed", async () => {
    const slug = "refunds";
    const { slugDir } = seedLeadTerminalWithCritiques(tmp, slug);

    let observedReviews: readonly CritiqueOutput[] | null = null;
    const lead: Adapter = {
      ...createFakeAdapter({}),
      revise: (input: ReviseInput): Promise<ReviseOutput> => {
        observedReviews = input.reviews;
        return Promise.resolve({
          spec: "# SPEC\n\nrecovered v0.2 from saved critiques\n",
          ready: true,
          rationale: JSON.stringify([
            {
              finding_ref: "codex#1",
              decision: "accepted",
              rationale: "addressed auth",
            },
          ]),
          usage: null,
          effort_used: "max",
        });
      },
    };

    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: {
        lead,
        reviewerA: explodingReviewer(),
        reviewerB: explodingReviewer(),
      },
      // > 1 so the `ready` stop (not `max-rounds`) fires after the
      // recovered round; a second round never starts because the lead
      // returned ready=true, which is the only way the exploding
      // reviewers stay un-invoked.
      maxRounds: 5,
      ...DEFAULT_TIME_INPUTS,
    });

    // Recovered, not dead-ended.
    expect(res.exitCode).toBe(0);
    expect(res.stopReason).toBe("ready");
    expect(res.finalVersion).toBe("0.2.0");

    // The "retrying without re-running reviewers" notice is on stdout.
    expect(res.stdout).toContain("saved reviewer");
    expect(res.stdout).toMatch(/without re-running reviewers/);

    // The lead's revise() received BOTH persisted critiques (reviewers
    // never ran, so these can only be the recovered ones).
    expect(observedReviews).not.toBeNull();
    expect(observedReviews!.length).toBe(2);
    const summaries = observedReviews!.map((c) => c.summary);
    expect(summaries).toContain("reviewer A saved summary");
    expect(summaries).toContain("reviewer B saved summary");

    // SPEC.md was rewritten by the recovered round.
    expect(readFileSync(path.join(slugDir, "SPEC.md"), "utf8")).toContain(
      "recovered v0.2 from saved critiques",
    );

    // round.json for the recovered round is complete with both seats ok.
    const sidecar = JSON.parse(
      readFileSync(path.join(slugDir, "reviews", "r01", "round.json"), "utf8"),
    ) as {
      status: string;
      seats: { reviewer_a: unknown; reviewer_b: unknown };
    };
    expect(sidecar.status).toBe("complete");
    expect(sidecar.seats.reviewer_a).toBe("ok");
    expect(sidecar.seats.reviewer_b).toBe("ok");

    // The lead_terminal state was cleared: state.json now records a
    // committed round, not the terminal exit.
    const finalState = JSON.parse(
      readFileSync(path.join(slugDir, "state.json"), "utf8"),
    ) as State;
    expect(finalState.round_state).not.toBe("lead_terminal");
    expect(finalState.round_index).toBe(1);
    expect(finalState.version).toBe("0.2.0");

    // The working tree is clean on exit (no orphan reviews/ or dirty
    // state.json), per the finalize-commit contract.
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: tmp,
      encoding: "utf8",
    });
    expect(status.stdout.trim()).toBe("");
  });

  test("still exits 4 at lead_terminal when NO critiques are on disk (absorbing branch)", async () => {
    // Regression guard for the OLD branch: a lead_terminal with no
    // recoverable critiques must remain a dead-end (exit 4).
    const slug = "refunds";
    seedLeadTerminalWithCritiques(tmp, slug, {
      seatA: null,
      seatB: null,
    });

    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: {
        // Lead would explode if reached — it must not be, exit 4 is
        // raised before any round runs.
        lead: explodingReviewer(),
        reviewerA: explodingReviewer(),
        reviewerB: explodingReviewer(),
      },
      maxRounds: 1,
      ...DEFAULT_TIME_INPUTS,
    });

    expect(res.exitCode).toBe(4);
    expect(res.stderr.toLowerCase()).toContain("lead_terminal");
  });
});

describe("cli/iterate — resume reuse is consumed ONCE", () => {
  test("reuse applies only to the failed round; later rounds run reviewers normally", async () => {
    // Seed lead_terminal at round 1 with saved critiques. The lead
    // returns ready=false on round 1 so the loop continues into round 2,
    // where the reuse MUST NOT apply — the reviewers must be invoked
    // again. A counting reviewer proves round 1 reused (0 calls) and
    // round 2 ran fresh (exactly 1 call).
    const slug = "refunds";
    const { slugDir } = seedLeadTerminalWithCritiques(tmp, slug);

    let aCalls = 0;
    let bCalls = 0;
    const countingReviewer = (
      counter: () => void,
      crit: CritiqueOutput,
    ): Adapter => ({
      ...createFakeAdapter({}),
      critique: (_input: CritiqueInput) => {
        counter();
        return Promise.resolve(crit);
      },
    });

    let reviseCall = 0;
    const reviewSummariesByCall: string[][] = [];
    const lead: Adapter = {
      ...createFakeAdapter({}),
      revise: (input: ReviseInput): Promise<ReviseOutput> => {
        reviseCall += 1;
        reviewSummariesByCall.push(input.reviews.map((c) => c.summary));
        // Round 1 (reuse): keep iterating. Round 2: converge.
        const ready = reviseCall >= 2;
        return Promise.resolve({
          spec: `# SPEC\n\nround ${String(reviseCall)} body\n`,
          ready,
          rationale: "[]",
          usage: null,
          effort_used: "max",
        });
      },
    };

    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: {
        lead,
        reviewerA: countingReviewer(() => {
          aCalls += 1;
        }, CRIT_A),
        reviewerB: countingReviewer(() => {
          bCalls += 1;
        }, CRIT_B),
      },
      maxRounds: 5,
      ...DEFAULT_TIME_INPUTS,
    });

    expect(res.exitCode).toBe(0);
    // Two rounds ran: the recovered round 1 + a fresh round 2.
    expect(reviseCall).toBe(2);

    // Round 1 reused the saved critiques: reviewers NOT invoked. Round 2
    // ran them once each. So each reviewer was called EXACTLY once total.
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);

    // Round 1's revise saw the SAVED summaries; round 2's revise saw the
    // FRESH critiques (same content here, but the call count above proves
    // they were freshly produced, not reused).
    expect(reviewSummariesByCall[0]).toContain("reviewer A saved summary");
    expect(reviewSummariesByCall[0]).toContain("reviewer B saved summary");
    expect(reviewSummariesByCall[1]?.length).toBe(2);

    // Final state advanced two rounds.
    const finalState = JSON.parse(
      readFileSync(path.join(slugDir, "state.json"), "utf8"),
    ) as State;
    expect(finalState.round_index).toBe(2);
  });
});
