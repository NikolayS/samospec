// Copyright 2026 Nikolay Samokhvalov.

// RED contract tests for Codex acting as the full samospec lead. A lead's
// revise prompt must preserve the user's authoritative brief, constrain the
// first draft to a concise size, and require the standard SPEC.md baseline.

import { describe, expect, test } from "bun:test";

import { buildRevisePrompt } from "../../src/adapter/codex.ts";
import type { ReviseInput } from "../../src/adapter/types.ts";

const ORIGINAL_IDEA =
  "Build a private tool for neighbors to lend equipment.\n" +
  "Do NOT turn this into a public social network or infer product scope from the slug.";
const NONSEMANTIC_SLUG = "public-social-network";

function leadInput(): ReviseInput {
  return {
    spec: "# Draft scaffold\n\nNo baseline headings are present here.",
    reviews: [],
    decisions_history: [],
    idea: ORIGINAL_IDEA,
    slug: NONSEMANTIC_SLUG,
    opts: { effort: "high", timeout: 1_800_000 },
  };
}

describe("Codex full-lead revise prompt", () => {
  test("places the original idea verbatim under an authoritative heading and marks the slug nonsemantic", () => {
    const prompt = buildRevisePrompt(leadInput());
    const headingIndex = prompt.search(
      /##\s+(?:Original|Project) idea[^\n]*AUTHORITATIVE/i,
    );
    const ideaIndex = prompt.indexOf(ORIGINAL_IDEA);

    expect({
      authoritativeHeading: headingIndex >= 0,
      ideaVerbatimBelowHeading: headingIndex >= 0 && ideaIndex > headingIndex,
      slugIncluded: prompt.includes(NONSEMANTIC_SLUG),
      slugMarkedNonsemantic:
        /slug[^\n]*(?:nonsemantic|non-semantic|identifier only)/i.test(prompt),
      semanticInferenceForbidden:
        /do not infer (?:project )?semantics from (?:the slug|it)/i.test(
          prompt,
        ),
    }).toEqual({
      authoritativeHeading: true,
      ideaVerbatimBelowHeading: true,
      slugIncluded: true,
      slugMarkedNonsemantic: true,
      semanticInferenceForbidden: true,
    });
  });

  test("requests a concise 800–1200-word first draft with a 1500-word hard maximum", () => {
    const prompt = buildRevisePrompt(leadInput());

    expect({
      concise: /concise/i.test(prompt),
      target800To1200: /800\s*(?:-|–|to)\s*1,?200\s*words?/i.test(prompt),
      hardMaximum1500:
        /(?:hard|max(?:imum)?)[^\n.]*1,?500|1,?500[^\n.]*(?:hard|max(?:imum)?)/i.test(
          prompt,
        ),
    }).toEqual({
      concise: true,
      target800To1200: true,
      hardMaximum1500: true,
    });
  });

  test("requires every baseline SPEC.md section", () => {
    const prompt = buildRevisePrompt(leadInput()).toLowerCase();
    const baselineSections = [
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

    const missingSections = baselineSections.filter(
      (section) => !prompt.includes(section),
    );
    expect({
      mandatoryFraming: /mandatory baseline sections|must include/.test(prompt),
      missingSections,
    }).toEqual({ mandatoryFraming: true, missingSections: [] });
  });
});
