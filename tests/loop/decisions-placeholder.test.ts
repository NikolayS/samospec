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

  test("fallback ID must not collide with explicit same-category ID in the same round", () => {
    // Reviewer-spotted collision bug: the lead mixes explicit and
    // missing finding_id values in the same category within one
    // revise call. The naive per-call counter starts at 1 and would
    // re-emit `ambiguity#1` for the missing-ID entry, duplicating
    // the explicit ID. Force the collision two ways:
    //
    //   1. Explicit IDs *precede* the missing one — counter starts at
    //      1 and steps into `ambiguity#1` (already taken) and then
    //      `ambiguity#3` (also already taken).
    //   2. A missing-ID entry *precedes* an explicit one — counter
    //      emits `ambiguity#2` for the missing entry, then the
    //      explicit `ambiguity#2` later in the same category clashes.
    //
    // The renderer must advance past any number already claimed by an
    // explicit ID in the same (category) scope for this call.
    const leadDecisions: readonly ReviseDecision[] = [
      // Case 1: explicit #1 and explicit #3 come first, then missing.
      {
        finding_id: "ambiguity#1",
        category: "ambiguity",
        verdict: "accepted",
        rationale: "Explicit #1.",
      },
      {
        finding_id: "ambiguity#3",
        category: "ambiguity",
        verdict: "accepted",
        rationale: "Explicit #3.",
      },
      {
        category: "ambiguity",
        verdict: "deferred",
        rationale: "Missing ID — must not collide.",
      },
      // Case 2: missing first, then explicit #2 — naive counter
      // would emit weak-testing#2 for the missing entry.
      {
        category: "weak-testing",
        verdict: "accepted",
        rationale: "Missing ID first.",
      },
      {
        finding_id: "weak-testing#2",
        category: "weak-testing",
        verdict: "rejected",
        rationale: "Explicit #2 after.",
      },
      {
        category: "weak-testing",
        verdict: "deferred",
        rationale: "Second missing — also must not collide.",
      },
    ];

    const entries = reviseDecisionsToReviewDecisions(leadDecisions);

    // Pull out every rendered finding_ref in order.
    const refs = entries.map((e) => e.finding_ref);

    // Core uniqueness invariant per category scope: no two decisions
    // in the same (category) scope share a rendered ID.
    const perCategory = new Map<string, Set<string>>();
    for (const ref of refs) {
      const [cat] = ref.split("#");
      if (cat === undefined) continue;
      const set = perCategory.get(cat) ?? new Set<string>();
      expect(set.has(ref)).toBe(false);
      set.add(ref);
      perCategory.set(cat, set);
    }

    // Explicit IDs must still be present verbatim.
    expect(refs).toContain("ambiguity#1");
    expect(refs).toContain("ambiguity#3");
    expect(refs).toContain("weak-testing#2");

    // End-to-end: rendered file also contains no duplicates for any
    // single category.
    const file = path.join(tmp, "decisions.md");
    appendRoundDecisions({
      file,
      roundNumber: 1,
      now: "2026-04-21T21:00:00Z",
      entries,
    });
    const body = readFileSync(file, "utf8");
    expect(body).not.toContain("#?");
    // ambiguity#1 appears exactly once (from the explicit decision).
    expect(body.match(/ambiguity#1\b/g)?.length ?? 0).toBe(1);
    // weak-testing#2 appears exactly once (from the explicit decision).
    expect(body.match(/weak-testing#2\b/g)?.length ?? 0).toBe(1);
  });
});
