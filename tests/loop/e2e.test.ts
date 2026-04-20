// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-e2e-"));
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

function buildCritique(suffix: number): CritiqueOutput {
  return {
    findings: [
      {
        category: "ambiguity",
        text: `finding #${String(suffix)} in spec body`,
        severity: "minor",
      },
      {
        category: "missing-risk",
        text: `risk #${String(suffix)} not addressed`,
        severity: "major",
      },
    ],
    summary: `round ${String(suffix)} summary`,
    suggested_next_version: `0.${String(suffix + 1)}`,
    usage: null,
    effort_used: "max",
  };
}

describe("loop/e2e — 3-round fake-adapter loop to ready=true", () => {
  test("produces v0.1 -> v0.2 -> v0.3 -> v0.4, ends with ready=true", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);
    const slugDir = path.join(tmp, ".samo", "spec", slug);

    let roundCounter = 0;
    const lead: Adapter = {
      vendor: "fake",
      detect: () =>
        Promise.resolve({ installed: true, version: "x", path: "/x" }),
      auth_status: () => Promise.resolve({ authenticated: true }),
      supports_structured_output: () => true,
      supports_effort: () => true,
      models: () => Promise.resolve([{ id: "x", family: "fake" }]),
      ask: () => Promise.reject(new Error("unused")),
      critique: () => Promise.reject(new Error("unused")),
      revise: () => {
        roundCounter += 1;
        const ready = roundCounter === 3;
        return Promise.resolve({
          spec: `# SPEC\n\nrevised body round ${String(roundCounter)}\n- item ${String(roundCounter)}\n`,
          ready,
          rationale: JSON.stringify([
            {
              finding_ref: "codex#1",
              decision: "accepted",
              rationale: `applied round ${String(roundCounter)}`,
            },
          ]),
          usage: null,
          effort_used: "max",
        });
      },
    };
    let cCounter = 0;
    const critiqueAdapter: Adapter = {
      ...createFakeAdapter({}),
      critique: () => {
        cCounter += 1;
        return Promise.resolve(buildCritique(cCounter));
      },
    };

    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: {
        lead,
        reviewerA: critiqueAdapter,
        reviewerB: critiqueAdapter,
      },
      maxRounds: 5,
      ...DEFAULT_TIME_INPUTS,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stopReason).toBe("ready");
    expect(res.roundsRun).toBe(3);
    expect(res.finalVersion).toBe("0.4.0");

    // Three round dirs present.
    const reviewsDir = path.join(slugDir, "reviews");
    const roundDirs = readdirSync(reviewsDir).sort();
    expect(roundDirs).toEqual(["r01", "r02", "r03"]);

    // Each round has round.json with status=complete.
    for (const rd of roundDirs) {
      const sidecar = JSON.parse(
        readFileSync(path.join(reviewsDir, rd, "round.json"), "utf8"),
      );
      expect(sidecar.status).toBe("complete");
      expect(sidecar.seats.reviewer_a).toBe("ok");
      expect(sidecar.seats.reviewer_b).toBe("ok");
      expect(existsSync(path.join(reviewsDir, rd, "codex.md"))).toBe(true);
      expect(existsSync(path.join(reviewsDir, rd, "claude.md"))).toBe(true);
    }

    // Changelog has entries for v0.2, v0.3, v0.4.
    const changelog = readFileSync(path.join(slugDir, "changelog.md"), "utf8");
    expect(changelog).toContain("v0.2 —");
    expect(changelog).toContain("v0.3 —");
    expect(changelog).toContain("v0.4 —");

    // Decisions has Round 1..3.
    const decisions = readFileSync(path.join(slugDir, "decisions.md"), "utf8");
    expect(decisions).toContain("Round 1");
    expect(decisions).toContain("Round 2");
    expect(decisions).toContain("Round 3");

    // Three refine commits in git log.
    const log = spawnSync("git", ["log", "--oneline"], {
      cwd: tmp,
      encoding: "utf8",
    });
    expect(log.stdout).toContain("refine v0.2 after review r1");
    expect(log.stdout).toContain("refine v0.3 after review r2");
    expect(log.stdout).toContain("refine v0.4 after review r3");

    // state.json final
    const finalState: State = JSON.parse(
      readFileSync(path.join(slugDir, "state.json"), "utf8"),
    );
    expect(finalState.version).toBe("0.4.0");
    expect(finalState.exit?.reason).toBe("ready");
    expect(finalState.exit?.code).toBe(0);
    expect(finalState.round_index).toBe(3);
  });
});

describe("loop/e2e — manual-edit mid-session", () => {
  test("user edits SPEC.md between iterate invocations -> incorporate commits + directive flows", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);
    const slugDir = path.join(tmp, ".samo", "spec", slug);

    // Round 1: ready=false so the loop doesn't stop.
    // Round 2 (second iterate call): ready=true after the edit lands.
    let roundCounter = 0;
    let sawDirective = false;

    const lead: Adapter = {
      vendor: "fake",
      detect: () =>
        Promise.resolve({ installed: true, version: "x", path: "/x" }),
      auth_status: () => Promise.resolve({ authenticated: true }),
      supports_structured_output: () => true,
      supports_effort: () => true,
      models: () => Promise.resolve([{ id: "x", family: "fake" }]),
      ask: () => Promise.reject(new Error("unused")),
      critique: () => Promise.reject(new Error("unused")),
      revise: (input) => {
        roundCounter += 1;
        if (
          roundCounter === 2 &&
          input.spec.includes("samospec:lead-directive")
        ) {
          sawDirective = true;
        }
        return Promise.resolve({
          spec: `# SPEC\n\nrevised round ${String(roundCounter)}\n`,
          ready: roundCounter >= 2,
          rationale: "[]",
          usage: null,
          effort_used: "max",
        });
      },
    };
    const critiqueAdapter = createFakeAdapter({
      critique: buildCritique(1),
    });

    // First iterate: run one round (ready=false -> halts at max=1).
    const r1 = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: {
        lead,
        reviewerA: critiqueAdapter,
        reviewerB: critiqueAdapter,
      },
      maxRounds: 1,
      ...DEFAULT_TIME_INPUTS,
    });
    expect(r1.exitCode).toBe(0);
    expect(r1.stopReason).toBe("max-rounds");

    // User edits SPEC.md between iterate calls.
    writeFileSync(
      path.join(slugDir, "SPEC.md"),
      "# SPEC\n\n## New Section\n\nuser-added paragraph between rounds.\n",
      "utf8",
    );

    // Second iterate: should detect the manual edit, commit it as
    // user-edit before round 2, pipe the directive into the next revise.
    const r2 = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: {
        lead,
        reviewerA: critiqueAdapter,
        reviewerB: critiqueAdapter,
      },
      maxRounds: 1,
      ...DEFAULT_TIME_INPUTS,
    });
    expect(r2.exitCode).toBe(0);
    expect(sawDirective).toBe(true);

    // Commit history includes a user-edit commit.
    const log = spawnSync("git", ["log", "--oneline"], {
      cwd: tmp,
      encoding: "utf8",
    });
    expect(log.stdout).toContain("user-edit before round 2");
  });
});

describe("loop/e2e — round.json status trail", () => {
  test("records seat outcomes as the round progresses", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);
    const slugDir = path.join(tmp, ".samo", "spec", slug);

    const lead: Adapter = createFakeAdapter({
      revise: {
        spec: "# SPEC\n\nrevised\n",
        ready: true,
        rationale: "[]",
        usage: null,
        effort_used: "max",
      },
    });
    const revA = createFakeAdapter({ critique: buildCritique(1) });
    const revB = createFakeAdapter({ critique: buildCritique(2) });

    await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: { lead, reviewerA: revA, reviewerB: revB },
      maxRounds: 1,
      ...DEFAULT_TIME_INPUTS,
    });
    const sidecar = JSON.parse(
      readFileSync(path.join(slugDir, "reviews", "r01", "round.json"), "utf8"),
    );
    expect(sidecar.round).toBe(1);
    expect(sidecar.status).toBe("complete");
    expect(sidecar.seats.reviewer_a).toBe("ok");
    expect(sidecar.seats.reviewer_b).toBe("ok");
    expect(typeof sidecar.started_at).toBe("string");
    expect(typeof sidecar.completed_at).toBe("string");
  });
});
