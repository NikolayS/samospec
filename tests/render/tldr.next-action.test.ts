// Copyright 2026 Nikolay Samokhvalov.

/**
 * RED integration test for #96: `.samo/spec/<slug>/TLDR.md` Next-action
 * section must reflect the canonical string for the current state, not
 * the hard-coded "resume with samospec resume <slug>".
 *
 * In particular, when state is converged (exit.reason = "ready") the
 * TLDR must say `samospec publish <slug>`.
 */

import { describe, expect, test } from "bun:test";

import { renderTldr } from "../../src/render/tldr.ts";
import type { State } from "../../src/state/types.ts";

const SLUG = "refunds";
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

const SPEC = "# demo\n\n## Goal\n\nShip it.\n\n## Scope\n\n- one\n";

describe("renderTldr — next action reflects state (#96)", () => {
  test("converged (exit.reason=ready) -> samospec publish <slug>", () => {
    const state = baseState({
      phase: "review_loop",
      round_index: 3,
      round_state: "committed",
      exit: { code: 0, reason: "ready", round_index: 3 },
    });
    const out = renderTldr(SPEC, { slug: SLUG, state });
    expect(out).toContain(`samospec publish ${SLUG}`);
    expect(out).not.toContain(`samospec resume ${SLUG}`);
  });

  test("pre-iterate -> samospec iterate <slug>", () => {
    const state = baseState({
      phase: "draft",
      round_index: 0,
      round_state: "committed",
      exit: null,
    });
    const out = renderTldr(SPEC, { slug: SLUG, state });
    expect(out).toContain(`samospec iterate ${SLUG}`);
  });

  test("mid-round in-flight -> samospec resume <slug>", () => {
    const state = baseState({
      phase: "review_loop",
      round_index: 1,
      round_state: "running",
      exit: null,
    });
    const out = renderTldr(SPEC, { slug: SLUG, state });
    expect(out).toContain(`samospec resume ${SLUG}`);
  });

  test("capped on wall-clock -> samospec iterate <slug>", () => {
    const state = baseState({
      phase: "review_loop",
      round_index: 2,
      round_state: "committed",
      exit: { code: 4, reason: "wall-clock", round_index: 2 },
    });
    const out = renderTldr(SPEC, { slug: SLUG, state });
    expect(out).toContain(`samospec iterate ${SLUG}`);
  });
});
