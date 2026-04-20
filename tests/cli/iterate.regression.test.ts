// Copyright 2026 Nikolay Samokhvalov.

/**
 * Regression tests for PR #30 BLOCKING review findings.
 *
 * Blocking #1 (SPEC §12 condition 3): semantic convergence must not
 *   fire on a single round. The classifier needs round-(N-1)'s signals
 *   as `previous` and round-N's as `current`; if they're both set to
 *   round-N's values, convergence collapses to "one low-delta round"
 *   and halts spuriously.
 *
 * Blocking #2 (SPEC §12 condition 4): repeat-findings halt must compare
 *   round N's findings against round (N-1)'s findings, same-category.
 *   If `previousFindings` is reassigned to the current round's findings
 *   BEFORE the classifier runs, every round with ≥5 findings compares
 *   itself against itself → Jaccard=1.0 → halt fires spuriously on
 *   round 1.
 *
 * Blocking #3 (SPEC §7): lead_terminal exit-4 message must be specific
 *   per sub-reason (refusal / schema_fail / invalid_input / budget /
 *   wall_clock / adapter_error) — not a single generic message.
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
import type {
  Adapter,
  CritiqueOutput,
  Finding,
  ReviseOutput,
} from "../../src/adapter/types.ts";
import { runIterate, type IterateResolvers } from "../../src/cli/iterate.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-iter-regr-"));
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
  writeFileSync(
    path.join(slugDir, "SPEC.md"),
    "# SPEC\n\nv0.1 body content\n- initial requirement\n",
    "utf8",
  );
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

const ACCEPT_RESOLVERS: IterateResolvers = {
  onManualEdit: () => Promise.resolve("incorporate"),
  onDegraded: () => Promise.resolve("accept"),
  onReviewerExhausted: () => Promise.resolve("abort"),
};
const TIME = {
  sessionStartedAtMs: 0,
  nowMs: 0,
  maxWallClockMs: 60 * 60 * 1000,
};

// ---------- Blocking #1: semantic convergence must require 2 rounds ----------

describe("iterate regression — semantic convergence needs 2 consecutive rounds (SPEC §12.3)", () => {
  test("single round with zero findings + small diff must not halt with semantic-convergence", async () => {
    seedSpec(tmp, "refunds");

    // Empty critiques -> zero non-summary categories; lead returns a
    // near-identical spec (tiny diff < 20 lines). Round 1 should NOT
    // halt with semantic-convergence because there is no "previous
    // round" to compare against.
    const emptyCritique: CritiqueOutput = {
      findings: [],
      summary: "nothing flagged",
      suggested_next_version: "0.2",
      usage: null,
      effort_used: "max",
    };
    const tinyRevise: ReviseOutput = {
      spec: "# SPEC\n\nv0.1 body content\n- initial requirement\n",
      ready: false,
      rationale: "[]",
      usage: null,
      effort_used: "max",
    };
    const lead = createFakeAdapter({ revise: tinyRevise });
    const crit = createFakeAdapter({ critique: emptyCritique });

    // maxRounds=3 so max-rounds cannot preempt the convergence check
    // on round 1. Without the bug, the only non-round-1 stop candidate
    // is that the loop reaches round 3 → max-rounds; with the bug,
    // semantic-convergence fires on round 1.
    const res = await runIterate({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: { lead, reviewerA: crit, reviewerB: crit },
      maxRounds: 3,
      ...TIME,
    });
    // After round 1 the classifier must still see NO previous round
    // — so semantic-convergence is impossible on round 1. Any stop on
    // round 1 other than `max-rounds` is a regression.
    if (res.stopReason === "semantic-convergence") {
      expect(res.roundsRun).toBeGreaterThanOrEqual(2);
    } else {
      // With two consecutive low-delta empty-findings rounds, the
      // classifier DOES legitimately converge at round 2 — which is
      // why maxRounds=3 never gets hit. What we're guarding is that
      // the stop did not fire on round 1.
      expect(res.roundsRun).toBeGreaterThanOrEqual(2);
    }
  });

  test("two consecutive low-delta empty-findings rounds DO halt with semantic-convergence", async () => {
    seedSpec(tmp, "refunds");

    // Both rounds emit zero findings and return near-identical specs.
    // Only at the END of round 2 should the classifier see the
    // previous (round 1) signals and fire semantic-convergence.
    const emptyCritique: CritiqueOutput = {
      findings: [],
      summary: "nothing flagged",
      suggested_next_version: "0.2",
      usage: null,
      effort_used: "max",
    };
    const tinyRevise: ReviseOutput = {
      spec: "# SPEC\n\nv0.1 body content\n- initial requirement\n",
      ready: false,
      rationale: "[]",
      usage: null,
      effort_used: "max",
    };
    const lead = createFakeAdapter({ revise: tinyRevise });
    const crit = createFakeAdapter({ critique: emptyCritique });

    const res = await runIterate({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: { lead, reviewerA: crit, reviewerB: crit },
      maxRounds: 3,
      ...TIME,
    });
    // After round 2 the classifier sees round-1 as "previous" with
    // low delta + zero non-summary findings and round-2 the same →
    // semantic-convergence fires.
    expect(res.stopReason).toBe("semantic-convergence");
    expect(res.roundsRun).toBe(2);
  });
});

// ---------- Blocking #2: repeat-findings halt compares rounds N vs N-1 ----------

function distinctFindingsA(): readonly Finding[] {
  return [
    { category: "ambiguity", text: "alpha one alpha first", severity: "minor" },
    { category: "ambiguity", text: "beta two beta second", severity: "minor" },
    {
      category: "ambiguity",
      text: "gamma three gamma third",
      severity: "minor",
    },
    {
      category: "ambiguity",
      text: "delta four delta fourth",
      severity: "minor",
    },
    {
      category: "ambiguity",
      text: "epsilon five epsilon fifth",
      severity: "minor",
    },
    { category: "ambiguity", text: "zeta six zeta sixth", severity: "minor" },
  ];
}

function distinctFindingsB(): readonly Finding[] {
  return [
    {
      category: "missing-risk",
      text: "omega alpha omega first risk",
      severity: "minor",
    },
    {
      category: "missing-risk",
      text: "psi beta psi second risk",
      severity: "minor",
    },
    {
      category: "missing-risk",
      text: "chi gamma chi third risk",
      severity: "minor",
    },
    {
      category: "missing-risk",
      text: "phi delta phi fourth risk",
      severity: "minor",
    },
    {
      category: "missing-risk",
      text: "upsilon epsilon upsilon fifth risk",
      severity: "minor",
    },
    {
      category: "missing-risk",
      text: "tau zeta tau sixth risk",
      severity: "minor",
    },
  ];
}

describe("iterate regression — repeat-findings halt compares round N to N-1 (SPEC §12.4)", () => {
  test("6 distinct findings in round 1 alone must not halt with lead-ignoring-critiques", async () => {
    seedSpec(tmp, "refunds");

    const lead = createFakeAdapter({
      revise: {
        spec: "# SPEC\n\nrevised round 1\n",
        ready: false,
        rationale: "[]",
        usage: null,
        effort_used: "max",
      },
    });
    // Reviewer A yields 6 distinct findings (well above the floor of 5).
    const revA = createFakeAdapter({
      critique: {
        findings: [...distinctFindingsA()],
        summary: "round 1 findings",
        suggested_next_version: "0.2",
        usage: null,
        effort_used: "max",
      },
    });
    const revB = createFakeAdapter({
      critique: {
        findings: [],
        summary: "none",
        suggested_next_version: "0.2",
        usage: null,
        effort_used: "max",
      },
    });

    const res = await runIterate({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: { lead, reviewerA: revA, reviewerB: revB },
      maxRounds: 1,
      ...TIME,
    });
    // Round 1 alone must NEVER trigger repeat-findings halt. The
    // "previous round" is empty; there is nothing to compare against.
    expect(res.stopReason).not.toBe("lead-ignoring-critiques");
    expect(res.roundsRun).toBe(1);
  });

  test("round 1 (6 findings) + round 2 (6 DIFFERENT findings, different category) must not halt", async () => {
    seedSpec(tmp, "refunds");

    // Two rounds with ZERO overlap: round 1 in `ambiguity`, round 2 in
    // `missing-risk`. Trigram Jaccard per finding must be 0.0 (same-
    // category filter) → repeat ratio 0% → no halt.
    let n = 0;
    const revAOutputs: readonly CritiqueOutput[] = [
      {
        findings: [...distinctFindingsA()],
        summary: "round 1",
        suggested_next_version: "0.2",
        usage: null,
        effort_used: "max",
      },
      {
        findings: [...distinctFindingsB()],
        summary: "round 2",
        suggested_next_version: "0.3",
        usage: null,
        effort_used: "max",
      },
    ];
    const revA: Adapter = {
      ...createFakeAdapter({}),
      critique: () => {
        const out = revAOutputs[Math.min(n, revAOutputs.length - 1)];
        n += 1;
        return Promise.resolve(out);
      },
    };
    const revB = createFakeAdapter({
      critique: {
        findings: [],
        summary: "none",
        suggested_next_version: "0.2",
        usage: null,
        effort_used: "max",
      },
    });
    const lead = createFakeAdapter({
      revise: {
        spec: "# SPEC\n\nrevised body\n",
        ready: false,
        rationale: "[]",
        usage: null,
        effort_used: "max",
      },
    });

    const res = await runIterate({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: { lead, reviewerA: revA, reviewerB: revB },
      maxRounds: 2,
      ...TIME,
    });
    // Two distinct rounds with zero trigram overlap must NOT halt.
    expect(res.stopReason).not.toBe("lead-ignoring-critiques");
    expect(res.roundsRun).toBe(2);
  });

  test("round 2 near-duplicates of round 1 DO halt with lead-ignoring-critiques on round 2 only", async () => {
    seedSpec(tmp, "refunds");

    // Round 1: 6 distinct findings. Round 2: same 6 findings with
    // minor whitespace / punctuation changes that normalize to the
    // same text → Jaccard ≈ 1.0 → halt fires at round 2.
    const round1Findings: readonly Finding[] = [...distinctFindingsA()];
    const round2Findings: readonly Finding[] = round1Findings.map((f) => ({
      category: f.category,
      text: `${f.text}.`, // trailing punctuation — normalized away
      severity: f.severity,
    }));
    let n = 0;
    const revAOutputs: readonly CritiqueOutput[] = [
      {
        findings: [...round1Findings],
        summary: "round 1",
        suggested_next_version: "0.2",
        usage: null,
        effort_used: "max",
      },
      {
        findings: [...round2Findings],
        summary: "round 2",
        suggested_next_version: "0.3",
        usage: null,
        effort_used: "max",
      },
    ];
    const revA: Adapter = {
      ...createFakeAdapter({}),
      critique: () => {
        const out = revAOutputs[Math.min(n, revAOutputs.length - 1)];
        n += 1;
        return Promise.resolve(out);
      },
    };
    const revB = createFakeAdapter({
      critique: {
        findings: [],
        summary: "none",
        suggested_next_version: "0.2",
        usage: null,
        effort_used: "max",
      },
    });
    const lead = createFakeAdapter({
      revise: {
        spec: "# SPEC\n\nrevised body with extra content to avoid convergence\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n- line\n",
        ready: false,
        rationale: "[]",
        usage: null,
        effort_used: "max",
      },
    });

    const res = await runIterate({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T12:00:00Z",
      resolvers: ACCEPT_RESOLVERS,
      adapters: { lead, reviewerA: revA, reviewerB: revB },
      maxRounds: 3,
      ...TIME,
    });
    expect(res.stopReason).toBe("lead-ignoring-critiques");
    expect(res.roundsRun).toBe(2);
  });
});

// ---------- Blocking #3: lead_terminal exit-4 sub-reason messaging ----------

interface TerminalSubCase {
  readonly label: string;
  readonly errorMessage: string;
  readonly expectedSubstring: string;
}

const TERMINAL_SUB_CASES: readonly TerminalSubCase[] = [
  {
    label: "refusal",
    errorMessage: "model refused to continue",
    expectedSubstring: "model refused",
  },
  {
    label: "schema_fail",
    errorMessage: "adapter returned schema violation",
    expectedSubstring: "invalid structured output",
  },
  {
    label: "invalid_input",
    errorMessage: "invalid input: spec too large or malformed",
    expectedSubstring: "spec too large or malformed",
  },
  {
    label: "budget",
    errorMessage: "budget cap hit: total_tokens_per_session exceeded",
    expectedSubstring: "budget cap hit",
  },
  {
    label: "wall_clock",
    errorMessage: "session wall-clock budget exhausted",
    expectedSubstring: "session wall-clock hit",
  },
];

describe("iterate regression — lead_terminal exit-4 messages are specific per sub-reason (SPEC §7)", () => {
  for (const sub of TERMINAL_SUB_CASES) {
    test(`sub-reason ${sub.label} surfaces "${sub.expectedSubstring}" in the exit-4 stderr`, async () => {
      seedSpec(tmp, "refunds");
      const leadTerminal: Adapter = {
        vendor: "fake",
        detect: () =>
          Promise.resolve({ installed: true, version: "x", path: "/x" }),
        auth_status: () => Promise.resolve({ authenticated: true }),
        supports_structured_output: () => true,
        supports_effort: () => true,
        models: () => Promise.resolve([{ id: "x", family: "fake" }]),
        ask: () => Promise.reject(new Error("unused")),
        critique: () => Promise.reject(new Error("unused")),
        revise: () => Promise.reject(new Error(sub.errorMessage)),
      };
      const revA = createFakeAdapter({
        critique: {
          findings: [
            { category: "ambiguity", text: "tiny", severity: "minor" },
          ],
          summary: "one",
          suggested_next_version: "0.2",
          usage: null,
          effort_used: "max",
        },
      });
      const res = await runIterate({
        cwd: tmp,
        slug: "refunds",
        now: "2026-04-19T12:00:00Z",
        resolvers: ACCEPT_RESOLVERS,
        adapters: {
          lead: leadTerminal,
          reviewerA: revA,
          reviewerB: revA,
        },
        maxRounds: 1,
        ...TIME,
      });
      expect(res.exitCode).toBe(4);
      expect(res.stopReason).toBe("lead-terminal");
      expect(res.stderr).toContain(sub.expectedSubstring);
    });
  }

  test("sub-reasons yield DIFFERENT messages (refusal vs schema_fail vs invalid_input)", async () => {
    seedSpec(tmp, "refunds");
    // Run three separate iterations in distinct temp dirs — the outer
    // beforeEach creates `tmp`, so we only have one seeded spec per
    // test. Here we assert the messages differ across the three runs
    // inside a single test by using distinct temp repos in-loop.
    const stderrs = new Map<string, string>();
    for (const label of ["refusal", "schema_fail", "invalid_input"]) {
      // Fresh subdir per sub-reason.
      const sub = mkdtempSync(
        path.join(tmpdir(), `samospec-iter-sub-${label}-`),
      );
      try {
        initRepo(sub);
        seedSpec(sub, "refunds");
        const errMsg =
          label === "refusal"
            ? "model refused"
            : label === "schema_fail"
              ? "adapter schema violation"
              : "invalid input: spec too large";
        const leadTerminal: Adapter = {
          vendor: "fake",
          detect: () =>
            Promise.resolve({ installed: true, version: "x", path: "/x" }),
          auth_status: () => Promise.resolve({ authenticated: true }),
          supports_structured_output: () => true,
          supports_effort: () => true,
          models: () => Promise.resolve([{ id: "x", family: "fake" }]),
          ask: () => Promise.reject(new Error("unused")),
          critique: () => Promise.reject(new Error("unused")),
          revise: () => Promise.reject(new Error(errMsg)),
        };
        const revA = createFakeAdapter({});
        const res = await runIterate({
          cwd: sub,
          slug: "refunds",
          now: "2026-04-19T12:00:00Z",
          resolvers: ACCEPT_RESOLVERS,
          adapters: { lead: leadTerminal, reviewerA: revA, reviewerB: revA },
          maxRounds: 1,
          ...TIME,
        });
        stderrs.set(label, res.stderr);
      } finally {
        rmSync(sub, { recursive: true, force: true });
      }
    }
    const refusal = stderrs.get("refusal") ?? "";
    const schemaFail = stderrs.get("schema_fail") ?? "";
    const invalidInput = stderrs.get("invalid_input") ?? "";
    expect(refusal).not.toBe(schemaFail);
    expect(refusal).not.toBe(invalidInput);
    expect(schemaFail).not.toBe(invalidInput);
    expect(refusal).toContain("model refused");
    expect(schemaFail).toContain("invalid structured output");
    expect(invalidInput).toContain("spec too large or malformed");
  });
});

// Silence unused-variable lint on readFileSync (keeps imports minimal).
void readFileSync;
