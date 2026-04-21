// Copyright 2026 Nikolay Samokhvalov.

/**
 * RED tests for #96: a single `computeNextAction(state, slug)` helper must
 * return one canonical next-action string per state shape. Three surfaces
 * (`iterate` stdout tail, `samospec status`, `.samo/spec/<slug>/TLDR.md`)
 * currently disagree — they must all route through this helper.
 *
 * Canonical next-action strings by state shape:
 *
 *   - converged (exit.reason ∈ ready / max-rounds / semantic-convergence /
 *     lead-ignoring-critiques) → `samospec publish <slug>`
 *   - published (phase=publish AND published_at set)               → none
 *   - lead_terminal (round_state=lead_terminal OR exit.reason lead-terminal)
 *         → `edit .samo/spec/<slug>/SPEC.md manually to recover`
 *   - capped on rounds (exit.reason max-rounds — already covered above,
 *     success). Here: "capped on wall-clock / budget / sigint /
 *     reviewers-exhausted / push-consent-interrupted" → `samospec iterate
 *     <slug>`
 *   - pre-iterate (phase=draft AND round_index=0 AND exit=null
 *     AND round_state=committed)                          → `samospec iterate
 *     <slug>`
 *   - mid-round committed (phase=review_loop AND round_state=committed
 *     AND exit=null)                                      → `samospec iterate
 *     <slug>`
 *   - mid-round in-flight (round_state ∈ planned/running/reviews_collected/
 *     lead_revised AND exit=null)                         → `samospec resume
 *     <slug>`
 */

import { describe, expect, test } from "bun:test";

import { computeNextAction } from "../../src/state/next-action.ts";
import type { State } from "../../src/state/types.ts";

const SLUG = "my-spec";
const NOW = "2026-04-19T12:00:00Z";

function baseState(override: Partial<State> = {}): State {
  const base: State = {
    slug: SLUG,
    phase: "review_loop",
    round_index: 0,
    version: "0.1.0",
    persona: { skill: SLUG, accepted: true },
    push_consent: null,
    calibration: null,
    remote_stale: false,
    coupled_fallback: false,
    head_sha: null,
    round_state: "committed",
    exit: null,
    created_at: NOW,
    updated_at: NOW,
  };
  return { ...base, ...override };
}

interface Row {
  readonly name: string;
  readonly state: State;
  readonly expected: string;
}

describe("computeNextAction — table-driven", () => {
  const rows: readonly Row[] = [
    {
      name: "pre-iterate: phase=draft, round_index=0, no exit",
      state: baseState({
        phase: "draft",
        round_index: 0,
        round_state: "committed",
        exit: null,
      }),
      expected: `samospec iterate ${SLUG}`,
    },
    {
      name: "mid-round committed (review_loop, no exit) -> iterate",
      state: baseState({
        phase: "review_loop",
        round_index: 2,
        round_state: "committed",
        exit: null,
      }),
      expected: `samospec iterate ${SLUG}`,
    },
    {
      name: "mid-round in-flight (planned) -> resume",
      state: baseState({
        phase: "review_loop",
        round_index: 1,
        round_state: "planned",
        exit: null,
      }),
      expected: `samospec resume ${SLUG}`,
    },
    {
      name: "mid-round in-flight (running) -> resume",
      state: baseState({
        phase: "review_loop",
        round_index: 1,
        round_state: "running",
        exit: null,
      }),
      expected: `samospec resume ${SLUG}`,
    },
    {
      name: "mid-round in-flight (reviews_collected) -> resume",
      state: baseState({
        phase: "review_loop",
        round_index: 1,
        round_state: "reviews_collected",
        exit: null,
      }),
      expected: `samospec resume ${SLUG}`,
    },
    {
      name: "mid-round in-flight (lead_revised) -> resume",
      state: baseState({
        phase: "review_loop",
        round_index: 1,
        round_state: "lead_revised",
        exit: null,
      }),
      expected: `samospec resume ${SLUG}`,
    },
    {
      name: "converged: exit.reason=ready -> publish",
      state: baseState({
        phase: "review_loop",
        round_index: 3,
        round_state: "committed",
        exit: { code: 0, reason: "ready", round_index: 3 },
      }),
      expected: `samospec publish ${SLUG}`,
    },
    {
      name: "converged: exit.reason=max-rounds -> publish",
      state: baseState({
        phase: "review_loop",
        round_index: 10,
        round_state: "committed",
        exit: { code: 0, reason: "max-rounds", round_index: 10 },
      }),
      expected: `samospec publish ${SLUG}`,
    },
    {
      name: "converged: exit.reason=semantic-convergence -> publish",
      state: baseState({
        phase: "review_loop",
        round_index: 5,
        round_state: "committed",
        exit: { code: 0, reason: "semantic-convergence", round_index: 5 },
      }),
      expected: `samospec publish ${SLUG}`,
    },
    {
      name: "converged: exit.reason=lead-ignoring-critiques -> publish",
      state: baseState({
        phase: "review_loop",
        round_index: 4,
        round_state: "committed",
        exit: { code: 4, reason: "lead-ignoring-critiques", round_index: 4 },
      }),
      expected: `samospec publish ${SLUG}`,
    },
    {
      name: "capped on wall-clock -> iterate to resume",
      state: baseState({
        phase: "review_loop",
        round_index: 2,
        round_state: "committed",
        exit: { code: 4, reason: "wall-clock", round_index: 2 },
      }),
      expected: `samospec iterate ${SLUG}`,
    },
    {
      name: "capped on budget -> iterate",
      state: baseState({
        phase: "review_loop",
        round_index: 2,
        round_state: "committed",
        exit: { code: 4, reason: "budget", round_index: 2 },
      }),
      expected: `samospec iterate ${SLUG}`,
    },
    {
      name: "sigint -> iterate",
      state: baseState({
        phase: "review_loop",
        round_index: 1,
        round_state: "committed",
        exit: { code: 3, reason: "sigint", round_index: 1 },
      }),
      expected: `samospec iterate ${SLUG}`,
    },
    {
      name: "reviewers-exhausted -> iterate",
      state: baseState({
        phase: "review_loop",
        round_index: 1,
        round_state: "committed",
        exit: { code: 4, reason: "reviewers-exhausted", round_index: 1 },
      }),
      expected: `samospec iterate ${SLUG}`,
    },
    {
      name: "push-consent-interrupted -> iterate",
      state: baseState({
        phase: "review_loop",
        round_index: 1,
        round_state: "committed",
        exit: { code: 3, reason: "push-consent-interrupted", round_index: 1 },
      }),
      expected: `samospec iterate ${SLUG}`,
    },
    {
      name: "lead_terminal round_state -> edit manually",
      state: baseState({
        phase: "review_loop",
        round_index: 2,
        round_state: "lead_terminal",
        exit: { code: 4, reason: "lead-terminal:refusal", round_index: 3 },
      }),
      expected: `edit .samo/spec/${SLUG}/SPEC.md manually to recover`,
    },
    {
      name: "lead-terminal exit reason -> edit manually",
      state: baseState({
        phase: "review_loop",
        round_index: 2,
        round_state: "committed",
        exit: { code: 4, reason: "lead-terminal", round_index: 3 },
      }),
      expected: `edit .samo/spec/${SLUG}/SPEC.md manually to recover`,
    },
    {
      name: "published: phase=publish with published_at -> already published",
      state: baseState({
        phase: "publish",
        round_index: 5,
        round_state: "committed",
        exit: { code: 0, reason: "ready", round_index: 5 },
        published_at: NOW,
        published_version: "v1.0",
      }),
      expected: `already published as v1.0`,
    },
    {
      name: "generic unknown exit reason -> iterate (safe fallback)",
      state: baseState({
        phase: "review_loop",
        round_index: 1,
        round_state: "committed",
        exit: { code: 4, reason: "some-unknown-future-reason", round_index: 1 },
      }),
      expected: `samospec iterate ${SLUG}`,
    },
  ];

  for (const row of rows) {
    test(row.name, () => {
      expect(computeNextAction(row.state, SLUG)).toBe(row.expected);
    });
  }
});

describe("computeNextAction — post-convergence parity (#96 core)", () => {
  test("any converged exit.reason emits `samospec publish <slug>`", () => {
    const converged: readonly string[] = [
      "ready",
      "max-rounds",
      "semantic-convergence",
      "lead-ignoring-critiques",
    ];
    for (const reason of converged) {
      const s = baseState({
        phase: "review_loop",
        round_state: "committed",
        round_index: 3,
        exit: {
          code: reason === "lead-ignoring-critiques" ? 4 : 0,
          reason,
          round_index: 3,
        },
      });
      expect(computeNextAction(s, SLUG)).toBe(`samospec publish ${SLUG}`);
    }
  });
});
