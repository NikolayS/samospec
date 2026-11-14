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
});
