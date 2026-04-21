// Copyright 2026 Nikolay Samokhvalov.

/**
 * Red-first TDD for #95: decisions.md must never contain the literal
 * `#?` placeholder. When the lead omits `finding_id` from a decision
 * object, the pipeline assigns a deterministic category-scoped ID so
 * every entry — accepted, deferred, rejected — ends up cross-linkable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  appendRoundDecisions,
  reviseDecisionsToReviewDecisions,
} from "../../src/loop/decisions.ts";
import type { ReviseDecision } from "../../src/adapter/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-decisions-placeholder-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("decisions.md must not emit '#?' placeholder IDs (#95)", () => {
  test("missing finding_id yields concrete category-scoped IDs", () => {
    // Fixture modelled on the repro in issue #95: multiple categories,
    // multiple findings per category, mixed verdicts — all with no
    // finding_id (the lead's common output shape today).
    const leadDecisions: readonly ReviseDecision[] = [
      {
        category: "missing-risk",
        verdict: "accepted",
        rationale: "Added §3 Threat Model.",
      },
      {
        category: "weak-implementation",
        verdict: "accepted",
        rationale: "§5.6 specifies 0600 socket in 0700 dir.",
      },
      {
        category: "ambiguity",
        verdict: "accepted",
        rationale: "`grace_s` is defined as a config key.",
      },
      {
        category: "ambiguity",
        verdict: "deferred",
        rationale: "Strict-mode escalation semantics deferred to v0.2.",
      },
      {
        category: "contradiction",
        verdict: "accepted",
        rationale: "`idle_gap_s` default is now 300 s.",
      },
    ];

    const entries = reviseDecisionsToReviewDecisions(leadDecisions);
    const file = path.join(tmp, "decisions.md");
    appendRoundDecisions({
      file,
      roundNumber: 1,
      now: "2026-04-21T19:14:21.784Z",
      entries,
    });

    const body = readFileSync(file, "utf8");

    // Core requirement from the issue: no literal '#?' anywhere.
    expect(body).not.toContain("#?");

    // Each entry should render with a concrete numeric ID following
    // the category label. Category-scoped counters mean we see
    // ambiguity#1 + ambiguity#2, etc.
    expect(body).toContain("missing-risk#1");
    expect(body).toContain("weak-implementation#1");
    expect(body).toContain("ambiguity#1");
    expect(body).toContain("ambiguity#2");
    expect(body).toContain("contradiction#1");
  });

  test("deferred and rejected findings also get concrete IDs", () => {
    const leadDecisions: readonly ReviseDecision[] = [
      {
        category: "weak-testing",
        verdict: "deferred",
        rationale: "Will address in sprint 2.",
      },
      {
        category: "weak-testing",
        verdict: "rejected",
        rationale: "Already covered by existing tests.",
      },
      {
        category: "unnecessary-scope",
        verdict: "rejected",
        rationale: "Out of v1 scope.",
      },
    ];

    const entries = reviseDecisionsToReviewDecisions(leadDecisions);
    const file = path.join(tmp, "decisions.md");
    appendRoundDecisions({
      file,
      roundNumber: 3,
      now: "2026-04-21T20:00:00Z",
      entries,
    });

    const body = readFileSync(file, "utf8");

    expect(body).not.toContain("#?");
    expect(body).toContain("- deferred weak-testing#1:");
    expect(body).toContain("- rejected weak-testing#2:");
    expect(body).toContain("- rejected unnecessary-scope#1:");
  });

  test("explicit finding_id from the lead is preserved verbatim", () => {
    // When the lead *does* emit finding_id, we do not rewrite it —
    // the substitution only fills in missing IDs.
    const leadDecisions: readonly ReviseDecision[] = [
      {
        finding_id: "codex#7",
        category: "ambiguity",
        verdict: "accepted",
        rationale: "Clarified.",
      },
      {
        category: "ambiguity",
        verdict: "accepted",
        rationale: "Also clarified.",
      },
    ];

    const entries = reviseDecisionsToReviewDecisions(leadDecisions);
    const file = path.join(tmp, "decisions.md");
    appendRoundDecisions({
      file,
      roundNumber: 1,
      now: "2026-04-21T19:00:00Z",
      entries,
    });

    const body = readFileSync(file, "utf8");

    expect(body).not.toContain("#?");
    expect(body).toContain("codex#7");
    // Missing-ID entry gets a category-scoped fallback number.
    expect(body).toContain("ambiguity#1");
  });
});
