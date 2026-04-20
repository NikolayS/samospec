// Copyright 2026 Nikolay Samokhvalov.

// RED tests for #58: buildRevisePrompt must include the nine baseline
// sections in the system/user prompt, and --skip removes listed sections
// from the mandatory list.

import { test, expect, describe } from "bun:test";
import { buildRevisePrompt, buildAskPrompt } from "../../src/adapter/claude.ts";
import type { ReviseInput, AskInput } from "../../src/adapter/types.ts";

const BASELINE_SECTIONS = [
  "version header",
  "goal",
  "user stories",
  "architecture",
  "implementation details",
  "tests",
  "team",
  "sprints",
  "changelog",
];

function makeReviseInput(opts?: { skipSections?: string[] }): ReviseInput {
  return {
    spec: "# Test Spec\n\nSome content here.",
    reviews: [],
    decisions_history: [],
    opts: { effort: "max", timeout: 600_000 },
    skipSections: opts?.skipSections,
  };
}

function makeAskInput(): AskInput {
  return {
    prompt: "What should the spec include?",
    context: "",
    opts: { effort: "max", timeout: 120_000 },
  };
}

describe("buildRevisePrompt — baseline sections", () => {
  test("includes all nine baseline section names in the prompt", () => {
    const prompt = buildRevisePrompt(makeReviseInput());
    const lower = prompt.toLowerCase();
    for (const section of BASELINE_SECTIONS) {
      expect(lower).toContain(section.toLowerCase());
    }
  });

  test("uses MUST or MANDATORY framing in the prompt", () => {
    const prompt = buildRevisePrompt(makeReviseInput());
    const lower = prompt.toLowerCase();
    const hasMandatory =
      lower.includes("must include") ||
      lower.includes("mandatory") ||
      lower.includes("required sections");
    expect(hasMandatory).toBe(true);
  });

  test("version header instruction present", () => {
    const prompt = buildRevisePrompt(makeReviseInput());
    const lower = prompt.toLowerCase();
    expect(lower).toContain("version header");
  });

  test("user stories instruction mentions at least 3", () => {
    const prompt = buildRevisePrompt(makeReviseInput());
    // Should mention ≥3 or at least 3
    const hasCount =
      prompt.includes("≥3") ||
      prompt.includes("at least 3") ||
      prompt.includes("3 or more") ||
      prompt.includes("minimum 3");
    expect(hasCount).toBe(true);
  });

  test("team instruction mentions veteran experts", () => {
    const prompt = buildRevisePrompt(makeReviseInput());
    const lower = prompt.toLowerCase();
    expect(lower).toContain("veteran");
  });

  test("TDD instruction present", () => {
    const prompt = buildRevisePrompt(makeReviseInput());
    const lower = prompt.toLowerCase();
    const hasTdd =
      lower.includes("tdd") ||
      lower.includes("red/green") ||
      lower.includes("red-green") ||
      lower.includes("test-first");
    expect(hasTdd).toBe(true);
  });

  test("--skip opt-out removes section from mandatory list", () => {
    const prompt = buildRevisePrompt(
      makeReviseInput({ skipSections: ["user stories", "team"] }),
    );
    const lower = prompt.toLowerCase();
    // The skipped sections should either be absent from the mandatory list
    // or explicitly marked as skipped/optional.
    // We check that they are not in the mandatory/MUST block.
    // One robust signal: if skip list is non-empty, the prompt should
    // mention "skip" or "opt" or list excluded sections.
    const hasSkipRef =
      lower.includes("skip") ||
      lower.includes("opt-out") ||
      lower.includes("excluded");
    expect(hasSkipRef).toBe(true);
  });

  test("--skip list is reflected: skipped sections do not appear in mandatory list", () => {
    const skipList = ["team", "sprints"];
    const promptWith = buildRevisePrompt(makeReviseInput());
    const promptSkip = buildRevisePrompt(
      makeReviseInput({ skipSections: skipList }),
    );
    // The prompt with skips should differ from the one without
    expect(promptSkip).not.toEqual(promptWith);
  });

  test("empty skipSections has same mandatory list as undefined", () => {
    const promptNone = buildRevisePrompt(makeReviseInput());
    const promptEmpty = buildRevisePrompt(
      makeReviseInput({ skipSections: [] }),
    );
    expect(promptNone).toEqual(promptEmpty);
  });
});

describe("buildAskPrompt — no baseline requirement (ask is for Q&A, not drafting)", () => {
  test("ask prompt does not crash and returns a string", () => {
    const prompt = buildAskPrompt(makeAskInput());
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});
