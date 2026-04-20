// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendRoundDecisions,
  buildDecisionSchemaLines,
  countDecisions,
  summarizeFindings,
} from "../../src/loop/decisions.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-loop-decisions-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("loop/decisions — summarizeFindings", () => {
  test("counts findings per category", () => {
    const sum = summarizeFindings([
      { category: "ambiguity", text: "a", severity: "minor" },
      { category: "ambiguity", text: "b", severity: "minor" },
      { category: "missing-risk", text: "c", severity: "major" },
    ]);
    expect(sum.total).toBe(3);
    expect(sum.byCategory.get("ambiguity")).toBe(2);
    expect(sum.byCategory.get("missing-risk")).toBe(1);
  });

  test("empty input", () => {
    const sum = summarizeFindings([]);
    expect(sum.total).toBe(0);
    expect(sum.byCategory.size).toBe(0);
  });
});

describe("loop/decisions — countDecisions", () => {
  test("counts each kind", () => {
    const c = countDecisions([
      { finding_ref: "f1", decision: "accepted", rationale: "yes" },
      { finding_ref: "f2", decision: "rejected", rationale: "no" },
      { finding_ref: "f3", decision: "accepted", rationale: "yes" },
      { finding_ref: "f4", decision: "deferred", rationale: "later" },
    ]);
    expect(c.accepted).toBe(2);
    expect(c.rejected).toBe(1);
    expect(c.deferred).toBe(1);
  });
});

describe("loop/decisions — appendRoundDecisions (file)", () => {
  test("creates decisions.md if absent with header + decisions", () => {
    const file = path.join(tmp, "decisions.md");
    const roundHeader = appendRoundDecisions({
      file,
      roundNumber: 1,
      now: "2026-04-19T12:00:00Z",
      entries: [
        {
          finding_ref: "codex#1",
          decision: "accepted",
          rationale: "valid point",
        },
        {
          finding_ref: "claude#1",
          decision: "deferred",
          rationale: "post-v1",
        },
      ],
    });
    const body = readFileSync(file, "utf8");
    expect(body).toContain("# decisions");
    expect(body).toContain("## Round 1 — 2026-04-19T12:00:00Z");
    expect(body).toContain("- accepted codex#1: valid point");
    expect(body).toContain("- deferred claude#1: post-v1");
    expect(roundHeader).toContain("Round 1");
  });

  test("appends when file already exists; preserves prior contents", () => {
    const file = path.join(tmp, "decisions.md");
    writeFileSync(
      file,
      "# decisions\n\n- No review-loop decisions yet. Populated during Sprint 3.\n",
      "utf8",
    );
    appendRoundDecisions({
      file,
      roundNumber: 2,
      now: "2026-04-19T12:30:00Z",
      entries: [
        {
          finding_ref: "codex#1",
          decision: "rejected",
          rationale: "out of scope",
        },
      ],
    });
    const body = readFileSync(file, "utf8");
    expect(body).toContain("# decisions");
    expect(body).toContain("## Round 2 — 2026-04-19T12:30:00Z");
    expect(body).toContain("- rejected codex#1: out of scope");
    // Seed bullet preserved.
    expect(body).toContain("No review-loop decisions yet");
  });

  test("handles empty entries by writing a stub note", () => {
    const file = path.join(tmp, "decisions.md");
    appendRoundDecisions({
      file,
      roundNumber: 1,
      now: "2026-04-19T12:00:00Z",
      entries: [],
    });
    const body = readFileSync(file, "utf8");
    expect(body).toContain("## Round 1");
    expect(body).toContain("no decisions");
  });
});

describe("loop/decisions — buildDecisionSchemaLines", () => {
  test("exposes the schema shape for prompt building", () => {
    const flat = buildDecisionSchemaLines().join(" ");
    expect(flat).toContain("accepted");
    expect(flat).toContain("rejected");
    expect(flat).toContain("deferred");
    expect(flat).toContain("finding_ref");
    expect(flat).toContain("rationale");
  });
});
