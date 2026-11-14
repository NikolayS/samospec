// Copyright 2026 Nikolay Samokhvalov.

import { expect, test } from "bun:test";

import { buildCritiquePrompt } from "../../src/adapter/codex.ts";

test("Codex reviewer enforces owner language, technical-note nesting, and requested scope", () => {
  const prompt = buildCritiquePrompt({
    spec: "# Bakery site",
    guidelines: "Review carefully.",
    idea: "A bakery site where customers order by phone or email.",
    opts: { effort: "high", timeout: 120_000 },
  });

  expect(prompt).toContain("## Technical notes");
  expect(prompt).toContain("jargon outside");
  expect(prompt).toContain("idea asked for");
  expect(prompt).toContain("needed for it to work safely");
  expect(prompt).toContain("Do not file missing-requirement findings");
  expect(prompt).toContain("A bakery site where customers order by phone or email.");
  expect(prompt).toMatch(/<repo_content_[0-9a-f]{8} /);
  expect(prompt).toContain("category `ambiguity`");
});

test("Codex reviewer honors skipped technical subsections", () => {
  const prompt = buildCritiquePrompt({
    spec: "# Bakery site",
    guidelines: "Review carefully.",
    skipSections: ["architecture", "team", "sprints"],
    opts: { effort: "high", timeout: 120_000 },
  });
  const policy = prompt.slice(prompt.indexOf("Section policy:"), prompt.indexOf("Guidelines:"));
  expect(policy).not.toContain("architecture");
  expect(policy).not.toContain("team of experts");
  expect(policy).not.toContain("sprints");
  expect(policy).toContain("implementation details");
});
