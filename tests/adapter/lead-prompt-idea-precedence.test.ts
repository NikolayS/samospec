// Copyright 2026 Nikolay Samokhvalov.

// RED tests for #85: --idea must be AUTHORITATIVE in all prompt builders.
// The slug is a filesystem identifier only — the lead must not infer
// project semantics from it when an idea string is present.
//
// Assertions use exact-substring matching so the implementation MUST
// contain the required directive wording verbatim.

import { describe, expect, test } from "bun:test";

import {
  buildAskPrompt,
  buildRevisePrompt,
} from "../../src/adapter/claude.ts";
import type { AskInput, ReviseInput } from "../../src/adapter/types.ts";

// ---------- shared fixtures ----------

const IDEA = "NOT a CRUD todo app";
const SLUG = "todo-stream";

function makeReviseInputWithIdea(overrides?: {
  idea?: string;
  slug?: string;
}): ReviseInput {
  return {
    spec: "# SPEC (v0.1 draft scaffold)\n\n## Project idea\n\ntodo\n",
    reviews: [],
    decisions_history: [],
    opts: { effort: "max", timeout: 600_000 },
    idea: overrides?.idea ?? IDEA,
    slug: overrides?.slug ?? SLUG,
  };
}

function makeAskInputWithIdea(overrides?: {
  idea?: string;
  slug?: string;
}): AskInput {
  return {
    prompt: "Propose a persona for this idea.",
    context: "",
    opts: { effort: "max", timeout: 120_000 },
    idea: overrides?.idea ?? IDEA,
    slug: overrides?.slug ?? SLUG,
  };
}

// ---------- buildRevisePrompt — idea-precedence framing ----------

describe("buildRevisePrompt — idea-precedence framing (#85)", () => {
  test('prompt contains the AUTHORITATIVE header "## Project idea (AUTHORITATIVE"', () => {
    const prompt = buildRevisePrompt(makeReviseInputWithIdea());
    expect(prompt).toContain("## Project idea (AUTHORITATIVE");
  });

  test("prompt contains the full --idea text verbatim", () => {
    const prompt = buildRevisePrompt(makeReviseInputWithIdea());
    expect(prompt).toContain(IDEA);
  });

  test('prompt contains "DO NOT infer semantics from it" slug directive', () => {
    const prompt = buildRevisePrompt(makeReviseInputWithIdea());
    expect(prompt).toContain("DO NOT infer semantics from it");
  });

  test('prompt contains "IDEA wins" conflict-resolution directive', () => {
    const prompt = buildRevisePrompt(makeReviseInputWithIdea());
    expect(prompt).toContain("IDEA wins");
  });

  test("slug appears under a non-authoritative header", () => {
    const prompt = buildRevisePrompt(makeReviseInputWithIdea());
    // The slug should appear in the prompt (under a non-authoritative header)
    expect(prompt).toContain(SLUG);
    // The slug section header must NOT contain "AUTHORITATIVE"
    const slugHeaderIdx = prompt.indexOf("Project slug");
    expect(slugHeaderIdx).toBeGreaterThanOrEqual(0);
    const slugSection = prompt.slice(slugHeaderIdx, slugHeaderIdx + 200);
    expect(slugSection).not.toContain("AUTHORITATIVE");
  });

  test("idea-precedence block appears when idea is provided", () => {
    const prompt = buildRevisePrompt(makeReviseInputWithIdea());
    // Must contain NOT disclaimers directive
    expect(prompt).toContain("NOT X");
  });

  test("when no idea/slug provided, prompt still works (no crash)", () => {
    const input: ReviseInput = {
      spec: "# SPEC\n\nContent.",
      reviews: [],
      decisions_history: [],
      opts: { effort: "max", timeout: 600_000 },
    };
    const prompt = buildRevisePrompt(input);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    // Without idea, AUTHORITATIVE block should not appear
    expect(prompt).not.toContain("## Project idea (AUTHORITATIVE");
  });
});

// ---------- buildAskPrompt — idea-precedence framing ----------

describe("buildAskPrompt — idea-precedence framing (#85)", () => {
  test('prompt contains the AUTHORITATIVE header when idea is provided', () => {
    const prompt = buildAskPrompt(makeAskInputWithIdea());
    expect(prompt).toContain("## Project idea (AUTHORITATIVE");
  });

  test("prompt contains the full --idea text verbatim", () => {
    const prompt = buildAskPrompt(makeAskInputWithIdea());
    expect(prompt).toContain(IDEA);
  });

  test('prompt contains "DO NOT infer semantics from it" slug directive', () => {
    const prompt = buildAskPrompt(makeAskInputWithIdea());
    expect(prompt).toContain("DO NOT infer semantics from it");
  });

  test('prompt contains "IDEA wins" conflict-resolution directive', () => {
    const prompt = buildAskPrompt(makeAskInputWithIdea());
    expect(prompt).toContain("IDEA wins");
  });

  test("ask prompt without idea still works (no crash, no AUTHORITATIVE block)", () => {
    const input: AskInput = {
      prompt: "Simple question.",
      context: "",
      opts: { effort: "max", timeout: 120_000 },
    };
    const prompt = buildAskPrompt(input);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).not.toContain("## Project idea (AUTHORITATIVE");
  });
});
