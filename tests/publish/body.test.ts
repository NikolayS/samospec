// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §5 Phase 7 — PR body composition.
 *
 * The body includes: spec summary (from TLDR.md), changelog since v0.1
 * (from changelog.md), round count, final exit reason, degraded
 * resolution summary (if any), hard + soft lint warnings.
 *
 * The rendered markdown uses `- ` list items (per CLAUDE.md) and clearly
 * labeled sections so reviewers can scan at a glance.
 */

import { describe, expect, test } from "bun:test";

import { buildPrBody } from "../../src/publish/body.ts";

const BASE_TLDR = [
  "# TL;DR",
  "",
  "## Goal",
  "",
  "Deliver a refunds policy.",
  "",
  "## Scope summary",
  "",
  "- refund window",
  "",
  "## Next action",
  "",
  "resume with `samospec resume refunds`",
  "",
].join("\n");

const BASE_CHANGELOG = [
  "# changelog",
  "",
  "## v0.1 — 2026-04-19T12:00:00Z",
  "",
  "- initial draft",
  "",
  "## v0.2 — 2026-04-19T12:30:00Z",
  "",
  "- Round 1 reviews applied.",
  "",
].join("\n");

describe("buildPrBody", () => {
  test("includes spec summary (TLDR), round count, and exit reason", () => {
    const body = buildPrBody({
      slug: "refunds",
      version: "v0.2",
      tldr: BASE_TLDR,
      changelog: BASE_CHANGELOG,
      roundCount: 1,
      exitReason: "ready",
      degradedResolution: null,
      lintReport: { hardWarnings: [], softWarnings: [] },
    });
    expect(body).toContain("refunds");
    expect(body).toContain("v0.2");
    expect(body).toContain("Deliver a refunds policy");
    expect(body).toMatch(/Rounds run:\s*1/i);
    expect(body).toMatch(/exit reason:\s*ready/i);
  });

  test("includes every changelog entry since v0.1", () => {
    const body = buildPrBody({
      slug: "refunds",
      version: "v0.2",
      tldr: BASE_TLDR,
      changelog: BASE_CHANGELOG,
      roundCount: 1,
      exitReason: "ready",
      degradedResolution: null,
      lintReport: { hardWarnings: [], softWarnings: [] },
    });
    expect(body).toContain("v0.1");
    expect(body).toContain("v0.2");
    expect(body).toContain("initial draft");
    expect(body).toContain("Round 1 reviews applied");
  });

  test("renders a degraded-resolution summary when present", () => {
    const body = buildPrBody({
      slug: "refunds",
      version: "v0.2",
      tldr: BASE_TLDR,
      changelog: BASE_CHANGELOG,
      roundCount: 2,
      exitReason: "ready",
      degradedResolution: "lead fell back to claude-sonnet-4-6",
      lintReport: { hardWarnings: [], softWarnings: [] },
    });
    expect(body).toMatch(/degraded/i);
    expect(body).toContain("lead fell back to claude-sonnet-4-6");
  });

  test(
    "renders hard warnings prominently and soft warnings in a " +
      "collapsible section",
    () => {
      const body = buildPrBody({
        slug: "refunds",
        version: "v0.2",
        tldr: BASE_TLDR,
        changelog: BASE_CHANGELOG,
        roundCount: 1,
        exitReason: "ready",
        degradedResolution: null,
        lintReport: {
          hardWarnings: [
            {
              id: "unknown-path",
              message: "References `src/refunds.ts` which does not exist.",
            },
          ],
          softWarnings: [
            {
              id: "unknown-command",
              message: "`curl` is not in the allowlist.",
            },
          ],
        },
      });
      // Hard warnings: labeled section, surfaced outside any details tag.
      expect(body).toMatch(/Hard warnings/i);
      expect(body).toContain("unknown-path");
      expect(body).toContain("src/refunds.ts");
      // Soft warnings: wrapped in <details> so reviewers can expand.
      expect(body).toContain("<details>");
      expect(body).toContain("</details>");
      expect(body).toContain("unknown-command");
    },
  );

  test("uses `- ` markdown list items throughout", () => {
    const body = buildPrBody({
      slug: "refunds",
      version: "v0.2",
      tldr: BASE_TLDR,
      changelog: BASE_CHANGELOG,
      roundCount: 1,
      exitReason: "ready",
      degradedResolution: null,
      lintReport: { hardWarnings: [], softWarnings: [] },
    });
    // No bare `*` bullets anywhere.
    expect(body).not.toMatch(/^\*\s/m);
  });
});
