// Copyright 2026 Nikolay Samokhvalov.

// RED tests: the reviewer critique prompt builders must inject the
// per-reviewer prior_context block + an explicit convergence instruction
// when CritiqueInput carries `prior_context`. When absent (round 1), the
// prompt is unchanged.
//
// Covers BOTH reviewer prompt builders:
//   - codex.ts buildCritiquePrompt (Reviewer A) — now exported.
//   - claude.ts buildCritiquePrompt (Reviewer B base) and the
//     buildCritiquePromptForReviewerB wrapper.

import { describe, expect, test } from "bun:test";

import { buildCritiquePrompt as buildCodexCritiquePrompt } from "../../src/adapter/codex.ts";
import { buildCritiquePrompt as buildClaudeCritiquePrompt } from "../../src/adapter/claude.ts";
import { buildCritiquePromptForReviewerB } from "../../src/adapter/claude-reviewer-b.ts";
import { CONVERGENCE_INSTRUCTION } from "../../src/loop/prior-context.ts";
import type { CritiqueInput } from "../../src/adapter/types.ts";

const BASE: CritiqueInput = {
  spec: "# SPEC v0.2\n\nbody",
  guidelines: "be thorough",
  opts: { effort: "max", timeout: 60_000 },
};

const PRIOR =
  "### Your prior findings\n- (major) AAA earlier finding\n\n" +
  "### Lead decisions\n- deferred missing-risk#1: punted to v0.3";

describe("convergence instruction constant", () => {
  test("is a non-empty string with the key convergence phrasing", () => {
    expect(typeof CONVERGENCE_INSTRUCTION).toBe("string");
    expect(CONVERGENCE_INSTRUCTION.length).toBeGreaterThan(0);
    expect(CONVERGENCE_INSTRUCTION.toLowerCase()).toContain("resolved");
    expect(CONVERGENCE_INSTRUCTION.toLowerCase()).toContain("converge");
  });
});

describe("codex (Reviewer A) buildCritiquePrompt — prior_context", () => {
  test("omits prior-context block when prior_context absent", () => {
    const prompt = buildCodexCritiquePrompt(BASE);
    expect(prompt).not.toContain(CONVERGENCE_INSTRUCTION);
    expect(prompt).not.toContain("AAA earlier finding");
  });

  test("includes prior findings + lead decisions + convergence instruction", () => {
    const prompt = buildCodexCritiquePrompt({ ...BASE, prior_context: PRIOR });
    expect(prompt).toContain("AAA earlier finding");
    expect(prompt).toContain("deferred missing-risk#1");
    expect(prompt).toContain(CONVERGENCE_INSTRUCTION);
  });
});

describe("claude (Reviewer B base) buildCritiquePrompt — prior_context", () => {
  test("omits prior-context block when prior_context absent", () => {
    const prompt = buildClaudeCritiquePrompt(BASE);
    expect(prompt).not.toContain(CONVERGENCE_INSTRUCTION);
  });

  test("includes prior findings + convergence instruction", () => {
    const prompt = buildClaudeCritiquePrompt({ ...BASE, prior_context: PRIOR });
    expect(prompt).toContain("AAA earlier finding");
    expect(prompt).toContain(CONVERGENCE_INSTRUCTION);
  });
});

describe("buildCritiquePromptForReviewerB — prior_context flows through", () => {
  test("includes prior findings + convergence instruction", () => {
    const prompt = buildCritiquePromptForReviewerB({
      ...BASE,
      prior_context: PRIOR,
    });
    expect(prompt).toContain("AAA earlier finding");
    expect(prompt).toContain(CONVERGENCE_INSTRUCTION);
  });
});
