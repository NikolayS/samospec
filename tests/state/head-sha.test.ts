// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §8 — `state.json.head_sha`. Records the local branch HEAD at the
 * time `state.json` was last written so remote-reconciliation can halt on
 * drift. Optional to stay backward-compatible with states written before
 * Sprint 3; newly-written states under Sprint 3 will fill it.
 */

import { describe, expect, test } from "bun:test";

import { stateSchema } from "../../src/state/types.ts";

const minimalState = {
  slug: "demo",
  phase: "detect",
  round_index: 0,
  version: "0.0.0",
  persona: null,
  push_consent: null,
  calibration: null,
  remote_stale: false,
  coupled_fallback: false,
  round_state: "planned",
  exit: null,
  created_at: "2026-04-19T00:00:00.000Z",
  updated_at: "2026-04-19T00:00:00.000Z",
};

describe("state/types — head_sha field (SPEC §8)", () => {
  test("accepts a valid 40-char lowercase hex sha", () => {
    const ok = {
      ...minimalState,
      head_sha: "1234567890abcdef1234567890abcdef12345678",
    };
    expect(stateSchema.parse(ok).head_sha).toBe(
      "1234567890abcdef1234567890abcdef12345678",
    );
  });

  test("accepts head_sha = null (first run, not yet resolved)", () => {
    const ok = { ...minimalState, head_sha: null };
    expect(stateSchema.parse(ok).head_sha).toBeNull();
  });

  test("accepts absence (omitted field) for backward compatibility", () => {
    // A state written before Sprint 3 lacks `head_sha`; schema must tolerate.
    const parsed = stateSchema.parse(minimalState);
    // Either undefined or null, depending on zod optionality style.
    expect(parsed.head_sha ?? null).toBeNull();
  });

  test("rejects a malformed sha (non-hex or wrong length)", () => {
    expect(() =>
      stateSchema.parse({ ...minimalState, head_sha: "not-a-sha" }),
    ).toThrow();
    expect(() =>
      stateSchema.parse({ ...minimalState, head_sha: "ABCDEF" }),
    ).toThrow(); // uppercase / too short
  });
});
