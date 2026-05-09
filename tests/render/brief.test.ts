// Copyright 2026 Nikolay Samokhvalov.

// Contract tests for the heuristic HTML brief renderer.
//
// What we lock down:
//   - Pure: same inputs → byte-identical output (only `now` varies).
//   - Content-forward: per-section rendering shows multiple
//     paragraphs, bulleted lists, code blocks (diagrams!), and
//     subsection names — not just a one-sentence TOC summary.
//   - Process metadata (rounds, persona, adapter models) lives in a
//     compact footer, NOT a prominent meta-grid.
//   - Inline markdown emphasis (`**bold**`, `*italic*`, `` `code` ``)
//     is rendered as `<strong>` / `<em>` / `<code>` rather than left
//     as literal asterisks/backticks.
//   - User-derived strings are HTML-escaped at every interpolation.

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
      "- API endpoints for partial and full refunds\n" +
      "- Admin UI for triage\n\n" +
      "## Out of scope\n\n" +
      "- Chargeback automation\n" +
      "- Anti-fraud (owned by risk team)\n\n" +
      "## Architecture\n\n" +
      "A refund is a state machine: requested → approved → settled.\n\n" +
      "```text\n" +
      "[user] → [API] → [state machine] → [ledger]\n" +
      "```\n\n" +
      "## Risks\n\n" +
      "- Concurrent refunds on the same order\n" +
      "- Reconciliation lag with the payment processor\n",
    tldr: "# TL;DR\n\n## Goal\n\nMake alpha customers happier.\n",
    changelog:
      "# changelog\n\n" +
      "## v0.1 — 2026-05-01\n\n- Initial draft.\n\n" +
      "## v0.2 — 2026-05-09\n\n- Round 1 review applied.\n",
    state: baseState(),
    now: NOW,
    ...overrides,
  };
}

describe("renderBrief — document shape", () => {
  test("emits a complete HTML5 document with the expected anchor sections", () => {
    const out = renderBrief(baseInput());
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain('<html lang="en">');
    expect(out).toContain('class="brief-hero"');
    expect(out).toContain('class="brief-goal"');
    expect(out).toContain('class="brief-section ');
    expect(out).toContain('class="brief-provenance"');
    expect(out.endsWith("</html>\n")).toBe(true);
  });

  test("kicker reads `Brief — derivative summary` (the contract)", () => {
    const out = renderBrief(baseInput());
    expect(out).toContain("Brief — derivative summary");
  });

  test("hero links to canonical SPEC.md and explains the 5–10 minute purpose", () => {
    const out = renderBrief(baseInput());
    expect(out).toContain('<a href="./SPEC.md">canonical SPEC.md →</a>');
    expect(out).toContain("5–10 minutes");
  });

  test("title element includes spec title and version label", () => {
    const out = renderBrief(baseInput());
    expect(out).toContain("<title>Brief — Alpha spec (v0.2)</title>");
  });
});

describe("renderBrief — content-forward sections (not process meta)", () => {
  test("does NOT render an `At a glance` meta-grid with adapter cards", () => {
    const out = renderBrief(baseInput());
    expect(out).not.toContain('class="brief-meta"');
    expect(out).not.toContain("At a glance");
  });

  test("does NOT render the round timeline as a major section", () => {
    const out = renderBrief(baseInput());
    expect(out).not.toContain('class="brief-timeline"');
    expect(out).not.toContain("Round timeline");
  });

  test("renders each H2 section with full paragraph(s), bullets, and code blocks", () => {
    const out = renderBrief(baseInput());
    expect(out).toContain(">Scope<");
    expect(out).toContain("Refunds API and admin UI for marketplace sellers.");
    expect(out).toContain("API endpoints for partial and full refunds");
    expect(out).toContain(">Architecture<");
    expect(out).toContain(
      "A refund is a state machine: requested → approved → settled.",
    );
    // Code block (the ASCII diagram) preserved verbatim.
    expect(out).toContain("<pre");
    expect(out).toContain("[user] → [API] → [state machine] → [ledger]");
  });

  test("classifies sections by heading and applies kind classes", () => {
    const out = renderBrief(baseInput());
    expect(out).toContain('class="brief-section brief-section-scope-out"');
    expect(out).toContain('class="brief-section brief-section-architecture"');
    expect(out).toContain('class="brief-section brief-section-risks"');
  });

  test("Goal section is rendered prominently and only once", () => {
    const out = renderBrief(baseInput());
    expect(out).toContain('class="brief-goal"');
    expect(out).toContain(
      "Make alpha customers happier with one-click refunds.",
    );
    // Goal must NOT appear again as a generic section.
    const generics = out.match(/class="brief-section brief-section-generic"/g);
    expect(generics === null || generics.length === 0).toBe(true);
  });
});

describe("renderBrief — diagrams and code preserved verbatim", () => {
  test("preserves fenced ```text``` ASCII diagrams inside their section", () => {
    const out = renderBrief(baseInput());
    expect(out).toContain("[user] → [API] → [state machine] → [ledger]");
    expect(out).toMatch(/<pre[^>]*data-lang="text"/);
  });

  test("preserves fenced ```mermaid``` diagrams with the language tag", () => {
    const spec =
      "# T\n\n## Goal\n\ng\n\n## Architecture\n\n" +
      "```mermaid\n" +
      "graph TD; A-->B;\n" +
      "```\n";
    const out = renderBrief(baseInput({ spec }));
    expect(out).toContain('data-lang="mermaid"');
    expect(out).toContain("graph TD; A--&gt;B;");
  });

  test("preserves ```sql``` code blocks with the language tag", () => {
    const spec =
      "# T\n\n## Goal\n\ng\n\n## Schema\n\n" +
      "```sql\n" +
      "CREATE TABLE refund (id bigserial PRIMARY KEY);\n" +
      "```\n";
    const out = renderBrief(baseInput({ spec }));
    expect(out).toContain('data-lang="sql"');
    expect(out).toContain("CREATE TABLE refund");
  });

  test("untagged ```...``` fence renders without a language attribute", () => {
    const spec = "# T\n\n## Goal\n\ng\n\n## Notes\n\n```\nplain code\n```\n";
    const out = renderBrief(baseInput({ spec }));
    expect(out).toContain("plain code");
    expect(out).toMatch(/<pre><code>/);
  });
});

describe("renderBrief — section opens with a list (no leading `-` leak)", () => {
  test("first bullet's content is shown as bullets, not as a paragraph starting with `-`", () => {
    const spec =
      "# T\n\n## Goal\n\ng\n\n## Non-goals\n\n" +
      "- Match TimescaleDB-class compression\n" +
      "- Multi-region replication\n";
    const out = renderBrief(baseInput({ spec }));
    expect(out).toContain("<li>Match TimescaleDB-class compression</li>");
    expect(out).not.toContain("<p>- Match TimescaleDB-class");
  });

  test("Non-goals heading classifies as scope-out", () => {
    const spec = "# T\n\n## Goal\n\ng\n\n## Non-goals\n\n- thing\n";
    const out = renderBrief(baseInput({ spec }));
    expect(out).toContain("brief-section-scope-out");
  });
});

describe("renderBrief — H2 with only H3 subsections falls back to a subsection summary", () => {
  test("collapses `<details>` element listing the H3 names appears", () => {
    const spec =
      "# T\n\n## Goal\n\ng\n\n## Detailed design\n\n" +
      "### Schema\n\n### Migrations\n\n### Rollout\n";
    const out = renderBrief(baseInput({ spec }));
    expect(out).toContain("brief-subsections");
    expect(out).toContain("Subsections (3)");
    expect(out).toContain("<li>Schema</li>");
    expect(out).toContain("<li>Migrations</li>");
    expect(out).toContain("<li>Rollout</li>");
  });

  test("a section with no body, no bullets, no subsections falls back to `See SPEC.md`", () => {
    const spec = "# T\n\n## Goal\n\ng\n\n## Truly empty\n";
    const out = renderBrief(baseInput({ spec }));
    expect(out).toContain("See SPEC.md for this section.");
  });
});

describe("renderBrief — inline markdown emphasis", () => {
  test("converts `**bold**` to `<strong>`", () => {
    const spec =
      "# T\n\n## Goal\n\nMake **bold things** happen.\n\n## Body\n\np\n";
    const out = renderBrief(baseInput({ spec }));
    expect(out).toContain("<strong>bold things</strong>");
    expect(out).not.toContain("**bold things**");
  });

  test("converts single `*italic*` to `<em>`", () => {
    const spec =
      "# T\n\n## Goal\n\n" +
      "Improve *latency* for the read path.\n\n" +
      "## Body\n\np\n";
    const out = renderBrief(baseInput({ spec }));
    expect(out).toContain("<em>latency</em>");
  });

  test("converts inline `` `code` `` to `<code>`", () => {
    const spec =
      "# T\n\n## Goal\n\nUse `INSERT … RETURNING` for the upsert path.\n\n" +
      "## Body\n\np\n";
    const out = renderBrief(baseInput({ spec }));
    expect(out).toContain("<code>INSERT … RETURNING</code>");
  });

  test("emphasis inside section bullets is rendered too", () => {
    const spec =
      "# T\n\n## Goal\n\ng\n\n## Risks\n\n" +
      "- Concurrent **refunds** on the same `order_id`\n";
    const out = renderBrief(baseInput({ spec }));
    expect(out).toContain("<strong>refunds</strong>");
    expect(out).toContain("<code>order_id</code>");
  });
});

describe("renderBrief — provenance footer (compact, not headline)", () => {
  test("includes round count, lead and reviewer adapter labels", () => {
    const out = renderBrief(baseInput());
    expect(out).toContain('class="brief-provenance"');
    expect(out).toContain("2 review rounds");
    expect(out).toContain("claude/claude-opus-4-7");
    expect(out).toContain("codex/gpt-5.4");
  });

  test("singular `1 review round` when changelog has only one entry", () => {
    const out = renderBrief(
      baseInput({
        changelog: "# changelog\n\n## v0.1 — 2026-05-01\n\n- Initial draft.\n",
      }),
    );
    expect(out).toContain("1 review round");
    expect(out).not.toContain("1 review rounds");
  });

  test("missing adapter snapshot renders `—` rather than crashing", () => {
    const out = renderBrief(
      baseInput({ state: baseState({ adapters: undefined }) }),
    );
    expect(out).toContain('class="brief-provenance"');
    expect(out).toContain("—");
  });

  test("coupled_fallback recorded surfaces a small banner near the top", () => {
    const out = renderBrief(
      baseInput({ state: baseState({ coupled_fallback: true }) }),
    );
    expect(out).toContain('class="brief-fallback"');
    expect(out).toContain("Coupled fallback recorded");
  });

  test("no coupled fallback → no banner element emitted", () => {
    const out = renderBrief(baseInput());
    expect(out).not.toContain('class="brief-fallback"');
    expect(out).not.toContain("Coupled fallback recorded");
  });
});

describe("renderBrief — determinism", () => {
  test("two calls with the same input produce identical output", () => {
    const a = renderBrief(baseInput());
    const b = renderBrief(baseInput());
    expect(a).toBe(b);
  });

  test("changing only `now` changes only the footer timestamp", () => {
    const a = renderBrief(baseInput());
    const b = renderBrief(baseInput({ now: "2026-06-01T00:00:00Z" }));
    expect(a).not.toBe(b);
    expect(b).toContain("<time>2026-06-01T00:00:00Z</time>");
  });
});

describe("renderBrief — security / escaping", () => {
  test("HTML-escapes title", () => {
    const spec = '# <script>alert("x")</script>\n\n## Goal\n\nGoal.\n';
    const out = renderBrief(baseInput({ spec }));
    expect(out).not.toContain("<script>alert(");
    expect(out).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  test("HTML-escapes inside section paragraphs (markdown emphasis still safe)", () => {
    const spec =
      "# T\n\n## Goal\n\nGoal text.\n\n## Body\n\n" +
      "Paragraph with <img onerror=x src=y> embedded **danger**.\n";
    const out = renderBrief(baseInput({ spec }));
    expect(out).not.toContain("<img onerror=x src=y>");
    expect(out).toContain("&lt;img onerror=x src=y&gt;");
    // Markdown still rendered.
    expect(out).toContain("<strong>danger</strong>");
  });

  test("HTML-escapes inside code blocks", () => {
    const spec =
      "# T\n\n## Goal\n\ng\n\n## Notes\n\n```\n<script>x</script>\n```\n";
    const out = renderBrief(baseInput({ spec }));
    expect(out).not.toContain("<script>x</script>");
    expect(out).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  test("HTML-escapes the slug in the provenance footer", () => {
    const out = renderBrief(baseInput({ slug: "<x>" }));
    expect(out).not.toContain("<code>samospec brief <x></code>");
    expect(out).toContain("samospec brief &lt;x&gt;");
  });

  test("rejects suspicious code-fence languages (drops the data-lang attribute)", () => {
    const spec = '# T\n\n## Goal\n\ng\n\n## Notes\n\n```"><script>\nx\n```\n';
    const out = renderBrief(baseInput({ spec }));
    expect(out).not.toContain('data-lang="\\"><script>"');
    expect(out).not.toContain("<script>");
  });
});

describe("renderBrief — degenerate inputs", () => {
  test("empty SPEC body falls back to slug as title", () => {
    const out = renderBrief(baseInput({ spec: "" }));
    expect(out).toContain("alpha");
    expect(out.endsWith("</html>\n")).toBe(true);
  });

  test("missing published_version renders an em dash", () => {
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

  test("Goal falls back to TLDR.md goal when SPEC has no Goal section or leading paragraph", () => {
    const spec = "# Bare\n\n## Scope\n\n- one\n";
    const tldr = "# TL;DR\n\n## Goal\n\nFallback goal sourced from TLDR.\n";
    const out = renderBrief(baseInput({ spec, tldr }));
    expect(out).toContain("Fallback goal sourced from TLDR.");
  });
});
