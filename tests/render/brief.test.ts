// Copyright 2026 Nikolay Samokhvalov.

// Contract tests for the heuristic HTML brief renderer.
//
// What we lock down:
//   - Pure: same inputs → byte-identical output (incl. order).
//   - The output is a complete HTML5 document with the expected
//     anchor sections so static-site hosts and screen readers see
//     real structure (not just a div soup).
//   - User-derived strings are HTML-escaped at every interpolation.
//   - Extractors mirror the heuristics already used in TLDR.md
//     (goal, sections), so a reader's mental model of the brief
//     matches the existing TLDR.md they already know.
//   - Changelog timeline parses the `## vX.Y — date` shape that
//     `samospec new` and round commits emit.

import { describe, expect, test } from "bun:test";

import { renderBrief, type BriefInput } from "../../src/render/brief.ts";
import type { State } from "../../src/state/types.ts";

const NOW = "2026-05-09T12:00:00Z";
const PUBLISHED_AT = "2026-05-09T11:55:00Z";
const CREATED_AT = "2026-05-01T09:00:00Z";

function baseState(overrides: Partial<State> = {}): State {
  return {
    slug: "alpha",
    phase: "publish",
    round_index: 3,
    version: "0.2.0",
    persona: { skill: "software-eng-pragmatic", accepted: true },
    push_consent: null,
    calibration: null,
    remote_stale: false,
    coupled_fallback: false,
    head_sha: null,
    round_state: "committed",
    exit: { code: 0, reason: "committed", round_index: 3 },
    adapters: {
      lead: {
        adapter: "claude",
        model_id: "claude-opus-4-7",
        effort_requested: "max",
        effort_used: "max",
      },
      reviewer_a: {
        adapter: "codex",
        model_id: "gpt-5.4",
        effort_requested: "max",
        effort_used: "max",
      },
      reviewer_b: {
        adapter: "claude",
        model_id: "claude-opus-4-7",
        effort_requested: "max",
        effort_used: "max",
      },
    },
    published_at: PUBLISHED_AT,
    published_version: "v0.2",
    created_at: CREATED_AT,
    updated_at: PUBLISHED_AT,
    ...overrides,
  } as State;
}

function baseInput(overrides: Partial<BriefInput> = {}): BriefInput {
  return {
    slug: "alpha",
    spec:
      "# Alpha spec\n\n" +
      "## Goal\n\n" +
      "Make alpha customers happier with one-click refunds.\n\n" +
      "## Scope\n\n" +
      "Refunds API and admin UI for marketplace sellers.\n\n" +
      "## Out of scope\n\n" +
      "Full chargeback automation. Anti-fraud is owned by the risk team.\n",
    tldr: "# TL;DR\n\n## Goal\n\nMake alpha customers happier.\n",
    changelog:
      "# changelog\n\n" +
      "## v0.1 — 2026-05-01\n\n" +
      "- Initial draft authored by the lead.\n" +
      "- Persona: software-eng-pragmatic\n\n" +
      "## v0.2 — 2026-05-09\n\n" +
      "- Round 1 review applied.\n" +
      "- Round 2 review applied.\n",
    state: baseState(),
    now: NOW,
    ...overrides,
  };
}

describe("renderBrief — document shape", () => {
  test("emits a complete HTML5 document", () => {
    const out = renderBrief(baseInput());
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain('<html lang="en">');
    expect(out).toContain("<head>");
    expect(out).toContain("</html>");
  });

  test("title element includes the spec title and version label", () => {
    const out = renderBrief(baseInput());
    expect(out).toContain("<title>Brief — Alpha spec (v0.2)</title>");
  });

  test("hero kicker reads `Brief — derivative summary` (the contract)", () => {
    const out = renderBrief(baseInput());
    expect(out).toContain("Brief — derivative summary");
  });

  test("explicit warning that this is a derivative, with a link to SPEC.md", () => {
    const out = renderBrief(baseInput());
    expect(out).toContain(
      "This is a summarized derivative of the spec, not the spec itself.",
    );
    expect(out).toContain('<a href="./SPEC.md">SPEC.md</a>');
  });

  test("renders all five top-level sections (header/meta/goal/toc/timeline/footer)", () => {
    const out = renderBrief(baseInput());
    expect(out).toContain('class="brief-header"');
    expect(out).toContain('class="brief-meta"');
    expect(out).toContain('class="brief-goal"');
    expect(out).toContain('class="brief-toc"');
    expect(out).toContain('class="brief-timeline"');
    expect(out).toContain('class="brief-footer"');
  });
});

describe("renderBrief — determinism (same input, byte-identical output)", () => {
  test("two calls with the same input produce identical output", () => {
    const a = renderBrief(baseInput());
    const b = renderBrief(baseInput());
    expect(a).toBe(b);
  });

  test("changing only `now` changes the footer timestamp deterministically", () => {
    const a = renderBrief(baseInput());
    const b = renderBrief(baseInput({ now: "2026-06-01T00:00:00Z" }));
    expect(a).not.toBe(b);
    expect(b).toContain("<time>2026-06-01T00:00:00Z</time>");
  });
});

describe("renderBrief — meta extraction from state", () => {
  test("renders rounds, persona, and adapter resolutions", () => {
    const out = renderBrief(baseInput());
    expect(out).toMatch(/Rounds[\s\S]+?>3</);
    expect(out).toContain("software-eng-pragmatic");
    expect(out).toContain("claude · claude-opus-4-7 · max");
    expect(out).toContain("codex · gpt-5.4 · max");
  });

  test("missing adapter snapshot renders an em dash, not crash", () => {
    const out = renderBrief(
      baseInput({
        state: baseState({ adapters: undefined }),
      }),
    );
    expect(out).toContain("—");
  });

  test("coupled-fallback recorded surfaces a visible warning banner", () => {
    const out = renderBrief(
      baseInput({
        state: baseState({ coupled_fallback: true }),
      }),
    );
    expect(out).toContain("brief-fallback");
    expect(out).toContain("Coupled fallback recorded");
  });

  test("no coupled fallback → no warning banner emitted", () => {
    const out = renderBrief(baseInput());
    // The CSS embeds a `.brief-fallback` selector unconditionally;
    // what we want is the absence of the actual element + message.
    expect(out).not.toContain('class="brief-fallback"');
    expect(out).not.toContain("Coupled fallback recorded");
  });
});

describe("renderBrief — section index", () => {
  test("lists each top-level `##` heading except Goal", () => {
    const out = renderBrief(baseInput());
    expect(out).toContain(">Scope<");
    expect(out).toContain(">Out of scope<");
    // Goal is rendered above as a dedicated paragraph, not in the index
    const tocRegion = sliceBetween(out, 'class="brief-toc"', "</section>");
    expect(tocRegion).not.toContain(">Goal<");
  });

  test("each section card includes a one-sentence summary, capped at 240 chars", () => {
    const longBody = "x".repeat(400) + ".";
    const spec =
      "# Long spec\n\n" +
      "## Goal\n\nMake things long.\n\n" +
      "## Section A\n\n" +
      longBody +
      "\n";
    const out = renderBrief(baseInput({ spec }));
    expect(out).toContain("…");
    expect(out).toContain("Section A");
  });

  test("a spec with no `##` sections beyond Goal renders an empty-state notice", () => {
    const spec = "# Tiny\n\n## Goal\n\nA goal.\n";
    const out = renderBrief(baseInput({ spec }));
    expect(out).toContain("No top-level sections found beyond Goal");
  });
});

describe("renderBrief — round timeline", () => {
  test("parses each `## vX.Y — date` entry with bullets", () => {
    const out = renderBrief(baseInput());
    const timeline = sliceBetween(out, 'class="brief-timeline"', "</section>");
    expect(timeline).toContain("v0.1");
    expect(timeline).toContain("v0.2");
    expect(timeline).toContain("Initial draft authored by the lead.");
    expect(timeline).toContain("Round 1 review applied.");
    expect(timeline).toContain("Round 2 review applied.");
  });

  test("entry without bullets still renders heading and date", () => {
    const changelog =
      "# changelog\n\n" + "## v0.1 — 2026-05-01\n\n" + "## v0.2 — 2026-05-09\n";
    const out = renderBrief(baseInput({ changelog }));
    expect(out).toContain("v0.1");
    expect(out).toContain("v0.2");
  });

  test("empty changelog (only `# changelog`) renders the empty-state notice", () => {
    const out = renderBrief(baseInput({ changelog: "# changelog\n" }));
    expect(out).toContain("No round entries in changelog.md.");
  });

  test("supports both em-dash and hyphen separators in entry headings", () => {
    const changelog =
      "# changelog\n\n" + "## v0.1 - 2026-05-01\n\n- first bullet\n";
    const out = renderBrief(baseInput({ changelog }));
    expect(out).toContain("v0.1");
    expect(out).toContain("first bullet");
  });
});

describe("renderBrief — goal extraction", () => {
  test("uses the `## Goal` paragraph from SPEC.md when present", () => {
    const out = renderBrief(baseInput());
    expect(out).toContain(
      "Make alpha customers happier with one-click refunds.",
    );
  });

  test("falls back to first paragraph after title when no Goal heading", () => {
    const spec =
      "# Headless\n\n" +
      "This document covers the headless flow end-to-end.\n\n" +
      "## Scope\n\n- one\n";
    const out = renderBrief(baseInput({ spec }));
    expect(out).toContain("This document covers the headless flow end-to-end.");
  });

  test("falls back to TLDR.md goal when SPEC has neither Goal nor a leading paragraph", () => {
    const spec = "# Bare\n\n## Scope\n\n- one\n";
    const tldr = "# TL;DR\n\n## Goal\n\nFallback goal sourced from TLDR.\n";
    const out = renderBrief(baseInput({ spec, tldr }));
    expect(out).toContain("Fallback goal sourced from TLDR.");
  });
});

describe("renderBrief — security / escaping", () => {
  test("HTML-escapes title content", () => {
    const spec = '# <script>alert("x")</script>\n\n## Goal\n\nGoal.\n';
    const out = renderBrief(baseInput({ spec }));
    expect(out).not.toContain("<script>alert(");
    expect(out).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  test("HTML-escapes goal paragraph content", () => {
    const spec =
      "# Title\n\n## Goal\n\nGoal with <img onerror=x src=y> embedded.\n";
    const out = renderBrief(baseInput({ spec }));
    expect(out).not.toContain("<img onerror=x src=y>");
    expect(out).toContain("&lt;img onerror=x src=y&gt;");
  });

  test("HTML-escapes section headings and summaries", () => {
    const spec =
      "# Title\n\n" +
      "## Goal\n\nA goal.\n\n" +
      '## <b>Bold heading</b>\n\nContent with "quotes" and <em>tags</em>.\n';
    const out = renderBrief(baseInput({ spec }));
    expect(out).not.toContain("<b>Bold heading</b>");
    expect(out).toContain("&lt;b&gt;Bold heading&lt;/b&gt;");
    expect(out).toContain("&quot;quotes&quot;");
  });

  test("HTML-escapes changelog bullets", () => {
    const changelog =
      "# changelog\n\n" +
      "## v0.1 — 2026-05-01\n\n" +
      '- bullet with <script>"&</script>\n';
    const out = renderBrief(baseInput({ changelog }));
    expect(out).not.toContain('<script>"&</script>');
    expect(out).toContain("&lt;script&gt;");
  });

  test("HTML-escapes the slug in the footer", () => {
    const out = renderBrief(baseInput({ slug: "<x>" }));
    expect(out).not.toContain("<code>samospec brief <x></code>");
    expect(out).toContain("samospec brief &lt;x&gt;");
  });
});

describe("renderBrief — degenerate inputs", () => {
  test("empty SPEC body falls back to slug as title", () => {
    const out = renderBrief(baseInput({ spec: "" }));
    expect(out).toContain("alpha");
    // Still emits a complete document
    expect(out).toContain("</html>");
  });

  test("missing published_version renders an em dash in the version slot", () => {
    const out = renderBrief(
      baseInput({
        state: baseState({
          published_version: undefined,
          published_at: undefined,
        }),
      }),
    );
    expect(out).toContain("Version —");
  });
});

// ---------- helpers ----------

function sliceBetween(haystack: string, after: string, before: string): string {
  const i = haystack.indexOf(after);
  if (i === -1) return "";
  const j = haystack.indexOf(before, i);
  if (j === -1) return haystack.slice(i);
  return haystack.slice(i, j);
}
