// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
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
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-iterate-"));
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
  // Seed a file so the branch has a HEAD.
  writeFileSync(path.join(cwd, "README.md"), "seed\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd });
}

function seedSpec(cwd: string, slug: string): State {
  const slugDir = path.join(cwd, ".samospec", "spec", slug);
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

// Every iterate test passes these defaults so the wall-clock check
// doesn't fire on tests that don't target it. The fixed pair keeps
// elapsed time at 0 and a 1-hour budget — plenty for the fake-adapter
// rounds which are effectively instantaneous.
const DEFAULT_TIME_INPUTS = {
  sessionStartedAtMs: 0,
  nowMs: 0,
  // Plenty larger than the worst-case one-round duration (~52.5 min).
  maxWallClockMs: 60 * 60 * 1000,
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

// ---------- basic tests ----------

describe("cli/iterate — preconditions", () => {
  test("exits 1 when state.json is missing", async () => {
    const lead = createFakeAdapter({});
    const res = await runIterate({
      cwd: tmp,
      slug: "missing-slug",
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: {
        lead,
        reviewerA: createFakeAdapter({}),
        reviewerB: createFakeAdapter({}),
      },
      maxRounds: 1,
      ...DEFAULT_TIME_INPUTS,
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("samospec new missing-slug");
  });

  test("exits 4 when state is lead_terminal", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);
    const slugDir = path.join(tmp, ".samospec", "spec", slug);
    const state: State = JSON.parse(
      readFileSync(path.join(slugDir, "state.json"), "utf8"),
    );
    writeState(path.join(slugDir, "state.json"), {
      ...state,
      round_state: "lead_terminal",
    });
    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: {
        lead: createFakeAdapter({}),
        reviewerA: createFakeAdapter({}),
        reviewerB: createFakeAdapter({}),
      },
    });
    expect(res.exitCode).toBe(4);
  });
});

// ---------- end-to-end happy round ----------

describe("cli/iterate — happy path (single round ready=true)", () => {
  test("bumps version v0.1 -> v0.2, writes reviews + changelog, commits", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);
    const slugDir = path.join(tmp, ".samospec", "spec", slug);

    const lead: Adapter = {
      ...createFakeAdapter({
        revise: {
          spec: "# SPEC\n\ncontent v0.2 revised\n",
          ready: true,
          rationale: JSON.stringify([
            { finding_ref: "codex#1", decision: "accepted", rationale: "yes" },
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
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: { lead, reviewerA: revA, reviewerB: revB },
      maxRounds: 5,
      ...DEFAULT_TIME_INPUTS,
    });

    expect(res.exitCode).toBe(0);
    expect(res.stopReason).toBe("ready");
    expect(res.finalVersion).toBe("0.2.0");
    expect(res.roundsRun).toBe(1);

    // Spec updated, round dir populated.
    expect(readFileSync(path.join(slugDir, "SPEC.md"), "utf8")).toContain(
      "content v0.2 revised",
    );
    expect(existsSync(path.join(slugDir, "reviews", "r01", "round.json"))).toBe(
      true,
    );
    expect(existsSync(path.join(slugDir, "reviews", "r01", "codex.md"))).toBe(
      true,
    );
    expect(existsSync(path.join(slugDir, "reviews", "r01", "claude.md"))).toBe(
      true,
    );
    const sidecar = JSON.parse(
      readFileSync(path.join(slugDir, "reviews", "r01", "round.json"), "utf8"),
    );
    expect(sidecar.status).toBe("complete");

    // Decisions appended.
    const dec = readFileSync(path.join(slugDir, "decisions.md"), "utf8");
    expect(dec).toContain("Round 1");
    expect(dec).toContain("accepted codex#1");

    // Changelog appended.
    const changelog = readFileSync(path.join(slugDir, "changelog.md"), "utf8");
    expect(changelog).toContain("v0.2 —");

    // Commit visible in git log.
    const log = spawnSync("git", ["log", "--oneline"], {
      cwd: tmp,
      encoding: "utf8",
    });
    expect(log.stdout).toContain("refine v0.2 after review r1");
  });
});

// ---------- max rounds ----------

describe("cli/iterate — max rounds", () => {
  test("halts after --rounds 2 when lead never ready", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);

    const lead: Adapter = createFakeAdapter({
      revise: {
        spec: "# SPEC\n\nkeep iterating\n",
        ready: false,
        rationale: "not yet",
        usage: null,
        effort_used: "max",
      },
    });
    const revA = createFakeAdapter({ critique: SAMPLE_CRITIQUE });
    const revB = createFakeAdapter({ critique: SAMPLE_CRITIQUE });

    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: { lead, reviewerA: revA, reviewerB: revB },
      maxRounds: 2,
      ...DEFAULT_TIME_INPUTS,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stopReason).toBe("max-rounds");
    expect(res.roundsRun).toBe(2);
    expect(res.finalVersion).toBe("0.3.0");
  });
});

// ---------- partial-failure ----------

describe("cli/iterate — partial reviewer failure", () => {
  test("one seat fails; round proceeds; directive mentions missing seat", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);
    const slugDir = path.join(tmp, ".samospec", "spec", slug);

    let observedLeadDirective: string | undefined;
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
        if (input.spec.includes("samospec:lead-directive")) {
          observedLeadDirective = input.spec.slice(
            input.spec.indexOf("samospec:lead-directive"),
          );
        }
        return Promise.resolve({
          spec: "# SPEC\n\nafter partial round\n",
          ready: true,
          rationale: "[]",
          usage: null,
          effort_used: "max",
        });
      },
    };
    const revA = createFakeAdapter({ critique: SAMPLE_CRITIQUE });
    const revB: Adapter = {
      ...revA,
      critique: () => Promise.reject(new Error("reviewer b crash")),
    };

    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: { lead, reviewerA: revA, reviewerB: revB },
      maxRounds: 1,
      ...DEFAULT_TIME_INPUTS,
    });

    expect(res.exitCode).toBe(0);
    expect(observedLeadDirective).toContain("Reviewer B");
    expect(observedLeadDirective).toContain("unavailable");

    const sidecar = JSON.parse(
      readFileSync(path.join(slugDir, "reviews", "r01", "round.json"), "utf8"),
    );
    expect(sidecar.status).toBe("partial");
    expect(sidecar.seats.reviewer_b).not.toBe("ok");
  });
});

// ---------- both seats fail + retry ----------

describe("cli/iterate — both seats fail then retry succeeds", () => {
  test("whole-round retry; second attempt OK", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);

    let aCalls = 0;
    let bCalls = 0;
    const failFirst = (label: string): Adapter => ({
      vendor: "fake",
      detect: () =>
        Promise.resolve({ installed: true, version: "x", path: "/x" }),
      auth_status: () => Promise.resolve({ authenticated: true }),
      supports_structured_output: () => true,
      supports_effort: () => true,
      models: () => Promise.resolve([{ id: "x", family: "fake" }]),
      ask: () => Promise.reject(new Error("unused")),
      critique: () => {
        if (label === "a") {
          aCalls += 1;
          if (aCalls === 1) return Promise.reject(new Error("first-fail a"));
        } else {
          bCalls += 1;
          if (bCalls === 1) return Promise.reject(new Error("first-fail b"));
        }
        return Promise.resolve(SAMPLE_CRITIQUE);
      },
      revise: () => Promise.reject(new Error("unused")),
    });

    const lead: Adapter = createFakeAdapter({
      revise: {
        spec: "# SPEC\n\nrecovered\n",
        ready: true,
        rationale: "[]",
        usage: null,
        effort_used: "max",
      },
    });

    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: {
        lead,
        reviewerA: failFirst("a"),
        reviewerB: failFirst("b"),
      },
      maxRounds: 1,
      ...DEFAULT_TIME_INPUTS,
    });
    expect(res.exitCode).toBe(0);
    expect(aCalls).toBe(2);
    expect(bCalls).toBe(2);
  });
});

// ---------- degraded resolution prompt ----------

describe("cli/iterate — degraded resolution prompt", () => {
  test("user abort on first-round degraded prompt -> exit 0 before round", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);

    const lead = createFakeAdapter({});
    let onDegradedCalled = false;

    const resolvers: IterateResolvers = {
      onManualEdit: () => Promise.resolve("incorporate"),
      onDegraded: () => {
        onDegradedCalled = true;
        return Promise.resolve("abort");
      },
      onReviewerExhausted: () => Promise.resolve("abort"),
    };

    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers,
      adapters: {
        lead,
        reviewerA: createFakeAdapter({}),
        reviewerB: createFakeAdapter({}),
      },
      resolutions: {
        lead: { adapter: "claude", model_id: "claude-sonnet-4-6" },
        reviewer_a: { adapter: "codex", model_id: "gpt-5.1-codex-max" },
        reviewer_b: { adapter: "claude", model_id: "claude-sonnet-4-6" },
        coupled_fallback: true,
      },
      maxRounds: 1,
      ...DEFAULT_TIME_INPUTS,
    });
    expect(onDegradedCalled).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.stopReason).toBe("sigint");
  });
});

// ---------- reviewer exhausted ----------

describe("cli/iterate — reviewers exhausted", () => {
  test("both seats fail both attempts -> exit 4 reviewers-exhausted", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);

    const failing: Adapter = {
      vendor: "fake",
      detect: () =>
        Promise.resolve({ installed: true, version: "x", path: "/x" }),
      auth_status: () => Promise.resolve({ authenticated: true }),
      supports_structured_output: () => true,
      supports_effort: () => true,
      models: () => Promise.resolve([{ id: "x", family: "fake" }]),
      ask: () => Promise.reject(new Error("unused")),
      critique: () => Promise.reject(new Error("persistent fail")),
      revise: () => Promise.reject(new Error("unused")),
    };
    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: {
        lead: createFakeAdapter({}),
        reviewerA: failing,
        reviewerB: failing,
      },
      maxRounds: 1,
      ...DEFAULT_TIME_INPUTS,
    });
    expect(res.exitCode).toBe(4);
    expect(res.stopReason).toBe("reviewers-exhausted");
  });
});

// ---------- lead_terminal ----------

describe("cli/iterate — lead_terminal", () => {
  test("lead revise throws -> exit 4, state.round_state=lead_terminal", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);
    const slugDir = path.join(tmp, ".samospec", "spec", slug);

    const terminalLead: Adapter = {
      vendor: "fake",
      detect: () =>
        Promise.resolve({ installed: true, version: "x", path: "/x" }),
      auth_status: () => Promise.resolve({ authenticated: true }),
      supports_structured_output: () => true,
      supports_effort: () => true,
      models: () => Promise.resolve([{ id: "x", family: "fake" }]),
      ask: () => Promise.reject(new Error("unused")),
      critique: () => Promise.reject(new Error("unused")),
      revise: () => Promise.reject(new Error("model refused")),
    };

    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: {
        lead: terminalLead,
        reviewerA: createFakeAdapter({ critique: SAMPLE_CRITIQUE }),
        reviewerB: createFakeAdapter({ critique: SAMPLE_CRITIQUE }),
      },
      maxRounds: 1,
      ...DEFAULT_TIME_INPUTS,
    });

    expect(res.exitCode).toBe(4);
    const finalState: State = JSON.parse(
      readFileSync(path.join(slugDir, "state.json"), "utf8"),
    );
    expect(finalState.round_state).toBe("lead_terminal");
  });
});

// ---------- wall-clock ----------

describe("cli/iterate — wall-clock overrun (SPEC §11)", () => {
  test("halts before next round when remaining < worst-case", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);

    const lead: Adapter = createFakeAdapter({
      revise: {
        spec: "# SPEC\n\nbody\n",
        ready: false,
        rationale: "[]",
        usage: null,
        effort_used: "max",
      },
    });
    // Budget 60s but the call worst-case is much larger.
    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: {
        lead,
        reviewerA: createFakeAdapter({ critique: SAMPLE_CRITIQUE }),
        reviewerB: createFakeAdapter({ critique: SAMPLE_CRITIQUE }),
      },
      // 1s budget — clearly < worst-case for default 300s+600s * 3.5.
      maxWallClockMs: 1_000,
      sessionStartedAtMs: 0,
      nowMs: 2_000, // already past budget
      maxRounds: 10,
    });
    expect(res.stopReason).toBe("wall-clock");
    expect(res.exitCode).toBe(4);
  });
});

// ---------- repeat-findings halt ----------

describe("cli/iterate — repeat-findings halt (SPEC §12 condition 4)", () => {
  test("halts with reason lead-ignoring-critiques when ≥5 near-identical findings repeat", async () => {
    const slug = "refunds";
    seedSpec(tmp, slug);

    // Fixture: 5 near-identical findings across 2 rounds, same category.
    const identicalCritique: CritiqueOutput = {
      findings: [
        {
          category: "ambiguity",
          text: "the spec is ambiguous about refunds",
          severity: "minor",
        },
        {
          category: "ambiguity",
          text: "the spec is ambiguous about returns",
          severity: "minor",
        },
        {
          category: "ambiguity",
          text: "the spec is ambiguous about shipping",
          severity: "minor",
        },
        {
          category: "ambiguity",
          text: "the spec is ambiguous about payments",
          severity: "minor",
        },
        {
          category: "ambiguity",
          text: "the spec is ambiguous about taxes",
          severity: "minor",
        },
      ],
      summary: "same findings",
      suggested_next_version: "0.2",
      usage: null,
      effort_used: "max",
    };

    const revA = createFakeAdapter({ critique: identicalCritique });
    // Reviewer B gives an empty critique so the round total is exactly 5
    // (still meets the floor).
    const revB = createFakeAdapter({
      critique: {
        findings: [],
        summary: "nothing",
        suggested_next_version: "0.2",
        usage: null,
        effort_used: "max",
      },
    });
    const lead = createFakeAdapter({
      revise: {
        spec: "# SPEC\n\nloop body\n",
        ready: false,
        rationale: "[]",
        usage: null,
        effort_used: "max",
      },
    });

    const res = await runIterate({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: { lead, reviewerA: revA, reviewerB: revB },
      maxRounds: 3,
      ...DEFAULT_TIME_INPUTS,
    });
    // After round 2 the halt should fire because round 2's findings
    // match round 1's with Jaccard ≥ 0.8.
    expect(res.stopReason).toBe("lead-ignoring-critiques");
    expect(res.exitCode).toBe(4);
  });
});
