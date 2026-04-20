// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type { Adapter, CritiqueOutput } from "../../src/adapter/types.ts";
import {
  buildLeadDirective,
  countDiffLines,
  countNonSummaryCategoriesWithFindings,
  extractDecisions,
  readRoundJson,
  recoverCritiqueFromFile,
  renderCritiqueMarkdown,
  roundDirsFor,
  runRound,
} from "../../src/loop/round.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-round-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------- fixtures ----------

const SAMPLE_CRITIQUE: CritiqueOutput = {
  findings: [
    {
      category: "ambiguity",
      text: "spec is ambiguous on refund policy",
      severity: "minor",
    },
    {
      category: "missing-risk",
      text: "no mention of rate limits",
      severity: "major",
    },
  ],
  summary: "two findings in total",
  suggested_next_version: "0.2",
  usage: null,
  effort_used: "max",
};

const READY_REVISE = {
  spec: "# SPEC\n\nrevised spec body",
  ready: true,
  rationale: JSON.stringify([
    {
      finding_ref: "codex#1",
      decision: "accepted",
      rationale: "added clarifying paragraph",
    },
    {
      finding_ref: "claude#1",
      decision: "deferred",
      rationale: "post-v1",
    },
  ]),
  usage: null,
  effort_used: "max" as const,
};

// ---------- tests: happy path ----------

describe("loop/round — happy-path runRound (SPEC §7)", () => {
  test("writes round.json, critique files, and returns revised spec", async () => {
    const lead = createFakeAdapter({ revise: READY_REVISE });
    const revA = createFakeAdapter({ critique: SAMPLE_CRITIQUE });
    const revB = createFakeAdapter({ critique: SAMPLE_CRITIQUE });

    const dirs = roundDirsFor(tmp, 1);

    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC\n\nv0.1 body",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
    });

    expect(outcome.roundStopReason).toBe("ok");
    expect(outcome.ready).toBe(true);
    expect(outcome.seats.reviewer_a.state).toBe("ok");
    expect(outcome.seats.reviewer_b.state).toBe("ok");
    expect(outcome.revisedSpec).toContain("revised spec body");
    expect(outcome.decisions.length).toBe(2);

    // round.json exists + status=complete.
    const sidecar = readRoundJson(dirs.roundJson);
    expect(sidecar?.status).toBe("complete");
    expect(sidecar?.seats.reviewer_a).toBe("ok");
    expect(sidecar?.seats.reviewer_b).toBe("ok");

    // Critique files written.
    expect(existsSync(dirs.codexPath)).toBe(true);
    expect(existsSync(dirs.claudePath)).toBe(true);
  });
});

// ---------- tests: partial-failure ----------

describe("loop/round — partial failure (SPEC §7)", () => {
  test("one seat fails -> directive mentions that seat; round proceeds", async () => {
    const lead = createFakeAdapter({ revise: READY_REVISE });
    const revA = createFakeAdapter({ critique: SAMPLE_CRITIQUE });
    // Failing reviewer B.
    const revB: Adapter = {
      vendor: "fake",
      detect: () => Promise.resolve({ installed: true, version: "x", path: "/x" }),
      auth_status: () => Promise.resolve({ authenticated: true }),
      supports_structured_output: () => true,
      supports_effort: () => true,
      models: () => Promise.resolve([{ id: "x", family: "fake" }]),
      ask: () => Promise.reject(new Error("not used")),
      critique: () => Promise.reject(new Error("fail: reviewer b crash")),
      revise: () => Promise.reject(new Error("not used")),
    };

    const dirs = roundDirsFor(tmp, 1);
    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "# SPEC\n\nbody",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
    });

    expect(outcome.roundStopReason).toBe("ok");
    expect(outcome.seats.reviewer_a.state).toBe("ok");
    expect(outcome.seats.reviewer_b.state).not.toBe("ok");
    expect(outcome.leadDirective).toContain("Reviewer B");
    expect(outcome.leadDirective).toContain("unavailable");

    const sidecar = readRoundJson(dirs.roundJson);
    expect(sidecar?.status).toBe("partial");
  });

  test("both seats fail -> whole-round retry", async () => {
    const lead = createFakeAdapter({ revise: READY_REVISE });
    let aCalls = 0;
    let bCalls = 0;
    const revA: Adapter = {
      vendor: "fake",
      detect: () => Promise.resolve({ installed: true, version: "x", path: "/x" }),
      auth_status: () => Promise.resolve({ authenticated: true }),
      supports_structured_output: () => true,
      supports_effort: () => true,
      models: () => Promise.resolve([{ id: "x", family: "fake" }]),
      ask: () => Promise.reject(new Error("unused")),
      critique: () => {
        aCalls += 1;
        if (aCalls === 1) return Promise.reject(new Error("first-fail a"));
        return Promise.resolve(SAMPLE_CRITIQUE);
      },
      revise: () => Promise.reject(new Error("unused")),
    };
    const revB: Adapter = {
      vendor: "fake",
      detect: () => Promise.resolve({ installed: true, version: "x", path: "/x" }),
      auth_status: () => Promise.resolve({ authenticated: true }),
      supports_structured_output: () => true,
      supports_effort: () => true,
      models: () => Promise.resolve([{ id: "x", family: "fake" }]),
      ask: () => Promise.reject(new Error("unused")),
      critique: () => {
        bCalls += 1;
        if (bCalls === 1) return Promise.reject(new Error("first-fail b"));
        return Promise.resolve(SAMPLE_CRITIQUE);
      },
      revise: () => Promise.reject(new Error("unused")),
    };

    const dirs = roundDirsFor(tmp, 1);
    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "body",
      decisionsHistory: [],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
    });
    expect(outcome.retried).toBe(true);
    expect(outcome.roundStopReason).toBe("ok");
    expect(aCalls).toBe(2);
    expect(bCalls).toBe(2);
  });

  test("both seats fail TWICE -> abandoned + reviewersExhausted=true", async () => {
    const lead = createFakeAdapter({ revise: READY_REVISE });
    const failingA: Adapter = {
      vendor: "fake",
      detect: () => Promise.resolve({ installed: true, version: "x", path: "/x" }),
      auth_status: () => Promise.resolve({ authenticated: true }),
      supports_structured_output: () => true,
      supports_effort: () => true,
      models: () => Promise.resolve([{ id: "x", family: "fake" }]),
      ask: () => Promise.reject(new Error("unused")),
      critique: () => Promise.reject(new Error("persistent-fail")),
      revise: () => Promise.reject(new Error("unused")),
    };
    const failingB: Adapter = { ...failingA };

    const dirs = roundDirsFor(tmp, 1);
    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "body",
      decisionsHistory: [],
      adapters: { lead, reviewerA: failingA, reviewerB: failingB },
    });

    expect(outcome.retried).toBe(true);
    expect(outcome.roundStopReason).toBe("both_seats_failed_even_after_retry");
    expect(outcome.reviewersExhausted).toBe(true);
    const sidecar = readRoundJson(dirs.roundJson);
    expect(sidecar?.status).toBe("abandoned");
  });
});

// ---------- tests: lead_terminal ----------

describe("loop/round — lead_terminal (SPEC §7)", () => {
  test("lead revise() throws -> roundStopReason=lead_terminal", async () => {
    const leadTerminal: Adapter = {
      vendor: "fake",
      detect: () => Promise.resolve({ installed: true, version: "x", path: "/x" }),
      auth_status: () => Promise.resolve({ authenticated: true }),
      supports_structured_output: () => true,
      supports_effort: () => true,
      models: () => Promise.resolve([{ id: "x", family: "fake" }]),
      ask: () => Promise.reject(new Error("unused")),
      critique: () => Promise.reject(new Error("unused")),
      revise: () =>
        Promise.reject(new Error("model refused to continue")),
    };
    const revA = createFakeAdapter({ critique: SAMPLE_CRITIQUE });
    const revB = createFakeAdapter({ critique: SAMPLE_CRITIQUE });
    const dirs = roundDirsFor(tmp, 1);
    const outcome = await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "body",
      decisionsHistory: [],
      adapters: { lead: leadTerminal, reviewerA: revA, reviewerB: revB },
    });
    expect(outcome.roundStopReason).toBe("lead_terminal");
    expect(outcome.rationale).toContain("lead_terminal");
  });
});

// ---------- tests: round directory formatter ----------

describe("loop/round — roundDirsFor", () => {
  test("pads round number to two digits", () => {
    const d = roundDirsFor("/tmp/slug", 1);
    expect(d.roundDir.endsWith("/reviews/r01")).toBe(true);
    const d10 = roundDirsFor("/tmp/slug", 10);
    expect(d10.roundDir.endsWith("/reviews/r10")).toBe(true);
  });
});

// ---------- tests: helpers ----------

describe("loop/round — helpers", () => {
  test("buildLeadDirective: both seats ok -> undefined", () => {
    expect(
      buildLeadDirective({ seatAOk: true, seatBOk: true }),
    ).toBeUndefined();
  });
  test("buildLeadDirective: only B ok -> mentions A", () => {
    const d = buildLeadDirective({ seatAOk: false, seatBOk: true });
    expect(d).toContain("Reviewer A");
  });
  test("buildLeadDirective: combines manual-edit directive", () => {
    const d = buildLeadDirective({
      seatAOk: true,
      seatBOk: true,
      manualEditDirective: "sections 7 and 9 manually edited",
    });
    expect(d).toContain("sections 7 and 9");
  });

  test("countDiffLines: identical -> 0", () => {
    expect(countDiffLines("abc\ndef", "abc\ndef")).toBe(0);
  });
  test("countDiffLines: one line changed -> 2", () => {
    // one line removed + one added = 2
    expect(countDiffLines("abc\ndef", "abc\nxyz")).toBe(2);
  });

  test("countNonSummaryCategoriesWithFindings", () => {
    // summary isn't in the review-taxonomy enum; if callers pass one,
    // it's still filtered out. Real-world findings have categories in
    // FindingCategorySchema which doesn't include summary.
    const n = countNonSummaryCategoriesWithFindings([
      { category: "ambiguity", text: "a", severity: "minor" },
      { category: "ambiguity", text: "b", severity: "minor" },
      { category: "missing-risk", text: "c", severity: "minor" },
    ]);
    expect(n).toBe(2);
  });

  test("renderCritiqueMarkdown + recoverCritiqueFromFile round-trip", () => {
    const body = renderCritiqueMarkdown(SAMPLE_CRITIQUE, "reviewer_a");
    const file = path.join(tmp, "codex.md");
    require("node:fs").writeFileSync(file, body, "utf8");
    const recovered = recoverCritiqueFromFile(file);
    expect(recovered).not.toBeNull();
    expect(recovered?.findings.length).toBe(2);
    expect(recovered?.summary).toBe("two findings in total");
  });

  test("extractDecisions reads JSON rationale", () => {
    const ds = extractDecisions(
      JSON.stringify([
        { finding_ref: "codex#1", decision: "accepted", rationale: "yes" },
      ]),
      "",
    );
    expect(ds.length).toBe(1);
  });

  test("extractDecisions reads spec marker", () => {
    const spec = `body
<!-- samospec:decisions v1 -->
[{"finding_ref":"claude#1","decision":"rejected","rationale":"no"}]
<!-- samospec:decisions end -->
more body`;
    const ds = extractDecisions("free-form prose", spec);
    expect(ds.length).toBe(1);
    expect(ds[0]?.decision).toBe("rejected");
  });

  test("extractDecisions returns [] on garbage", () => {
    expect(extractDecisions("not json", "no markers").length).toBe(0);
  });
});

// ---------- tests: decisions_history is passed through to revise ----------

describe("loop/round — decisions_history passthrough", () => {
  test("passes decisions_history into revise()", async () => {
    let seenHistory: unknown;
    const lead: Adapter = {
      vendor: "fake",
      detect: () => Promise.resolve({ installed: true, version: "x", path: "/x" }),
      auth_status: () => Promise.resolve({ authenticated: true }),
      supports_structured_output: () => true,
      supports_effort: () => true,
      models: () => Promise.resolve([{ id: "x", family: "fake" }]),
      ask: () => Promise.reject(new Error("unused")),
      critique: () => Promise.reject(new Error("unused")),
      revise: (input) => {
        seenHistory = input.decisions_history;
        return Promise.resolve(READY_REVISE);
      },
    };
    const revA = createFakeAdapter({ critique: SAMPLE_CRITIQUE });
    const revB = createFakeAdapter({ critique: SAMPLE_CRITIQUE });
    const dirs = roundDirsFor(tmp, 1);
    await runRound({
      now: "2026-04-19T12:00:00Z",
      roundNumber: 1,
      dirs,
      specText: "body",
      decisionsHistory: [
        {
          finding_ref: "prior#1",
          decision: "accepted",
          rationale: "already-landed",
        },
      ],
      adapters: { lead, reviewerA: revA, reviewerB: revB },
    });
    expect(Array.isArray(seenHistory)).toBe(true);
    expect((seenHistory as unknown[]).length).toBe(1);
  });
});
