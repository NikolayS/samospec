// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import {
  PHASES,
  ROUND_STATES,
  SEAT_STATES,
  ROUND_STATUSES,
  stateSchema,
  roundSchema,
  lockSchema,
  type Phase,
  type RoundState,
} from "../../src/state/types.ts";

const minimalState = {
  slug: "demo",
  phase: "detect" as Phase,
  round_index: 0,
  version: "0.0.0",
  persona: null,
  push_consent: null,
  calibration: null,
  remote_stale: false,
  coupled_fallback: false,
  round_state: "planned" as RoundState,
  exit: null,
  created_at: "2026-04-19T00:00:00.000Z",
  updated_at: "2026-04-19T00:00:00.000Z",
};

describe("state/types — phase + round state tables (SPEC §5, §7)", () => {
  test("PHASES lists all eight SPEC §5 phases", () => {
    expect(PHASES).toEqual([
      "detect",
      "branch_lock_preflight",
      "persona",
      "context",
      "interview",
      "draft",
      "review_loop",
      "publish",
    ]);
  });

  test("ROUND_STATES lists the six SPEC §7 states", () => {
    expect(ROUND_STATES).toEqual([
      "planned",
      "running",
      "reviews_collected",
      "lead_revised",
      "committed",
      "lead_terminal",
    ]);
  });

  test("SEAT_STATES lists the five reviewer seat labels", () => {
    expect(SEAT_STATES).toEqual([
      "pending",
      "ok",
      "failed",
      "schema_violation",
      "timeout",
    ]);
  });

  test("ROUND_STATUSES lists the five round sidecar status labels", () => {
    expect(ROUND_STATUSES).toEqual([
      "planned",
      "running",
      "complete",
      "partial",
      "abandoned",
    ]);
  });
});

describe("state/types — state.json zod schema (SPEC §5, §7)", () => {
  test("accepts a minimal valid state with all required fields", () => {
    const parsed = stateSchema.parse(minimalState);
    expect(parsed.slug).toBe("demo");
    expect(parsed.phase).toBe("detect");
    expect(parsed.round_index).toBe(0);
    expect(parsed.version).toBe("0.0.0");
    expect(parsed.round_state).toBe("planned");
    expect(parsed.remote_stale).toBe(false);
    expect(parsed.coupled_fallback).toBe(false);
  });

  test("rejects an unknown phase value", () => {
    const bad = { ...minimalState, phase: "bogus" };
    expect(() => stateSchema.parse(bad)).toThrow();
  });

  test("rejects an unknown round_state value", () => {
    const bad = { ...minimalState, round_state: "nope" };
    expect(() => stateSchema.parse(bad)).toThrow();
  });

  test("rejects a negative round_index", () => {
    const bad = { ...minimalState, round_index: -1 };
    expect(() => stateSchema.parse(bad)).toThrow();
  });

  test("rejects a non-SemVer version string", () => {
    const bad = { ...minimalState, version: "1.0" };
    expect(() => stateSchema.parse(bad)).toThrow();
  });

  test("rejects extra unknown top-level fields", () => {
    const bad = { ...minimalState, wat: true };
    expect(() => stateSchema.parse(bad)).toThrow();
  });

  test("accepts a populated persona record", () => {
    const parsed = stateSchema.parse({
      ...minimalState,
      persona: { skill: "security", accepted: true },
    });
    expect(parsed.persona?.skill).toBe("security");
  });

  test("accepts an exit record with reason + round_index", () => {
    const parsed = stateSchema.parse({
      ...minimalState,
      exit: { code: 4, reason: "lead_terminal", round_index: 2 },
    });
    expect(parsed.exit?.code).toBe(4);
  });

  // SPEC §5 Phase 7 + Issue #32 — publish state advance.
  test("accepts published_at + published_version + published_pr_url", () => {
    const parsed = stateSchema.parse({
      ...minimalState,
      published_at: "2026-04-19T13:00:00Z",
      published_version: "v0.2",
      published_pr_url: "https://github.com/demo/demo/pull/1",
    });
    expect(parsed.published_at).toBe("2026-04-19T13:00:00Z");
    expect(parsed.published_version).toBe("v0.2");
    expect(parsed.published_pr_url).toBe("https://github.com/demo/demo/pull/1");
  });

  test("allows published_pr_url to be absent (compare-URL fallback)", () => {
    const parsed = stateSchema.parse({
      ...minimalState,
      published_at: "2026-04-19T13:00:00Z",
      published_version: "v0.2",
    });
    expect(parsed.published_pr_url).toBeUndefined();
  });

  test("rejects published_version that does not start with `v`", () => {
    expect(() =>
      stateSchema.parse({
        ...minimalState,
        published_at: "2026-04-19T13:00:00Z",
        published_version: "0.2",
      }),
    ).toThrow();
  });
});

describe("state/types — round.json zod schema (SPEC §7)", () => {
  test("accepts a minimal planned round", () => {
    const parsed = roundSchema.parse({
      round: 1,
      status: "planned",
      seats: { reviewer_a: "pending", reviewer_b: "pending" },
      started_at: "2026-04-19T00:00:00.000Z",
    });
    expect(parsed.round).toBe(1);
    expect(parsed.seats.reviewer_a).toBe("pending");
  });

  test("allows completed_at on a completed round", () => {
    const parsed = roundSchema.parse({
      round: 1,
      status: "complete",
      seats: { reviewer_a: "ok", reviewer_b: "ok" },
      started_at: "2026-04-19T00:00:00.000Z",
      completed_at: "2026-04-19T01:00:00.000Z",
    });
    expect(parsed.completed_at).toBeDefined();
  });

  test("rejects round index 0 (rounds are 1-indexed in SPEC §9)", () => {
    expect(() =>
      roundSchema.parse({
        round: 0,
        status: "planned",
        seats: { reviewer_a: "pending", reviewer_b: "pending" },
        started_at: "2026-04-19T00:00:00.000Z",
      }),
    ).toThrow();
  });

  test("rejects an unknown seat label", () => {
    expect(() =>
      roundSchema.parse({
        round: 1,
        status: "planned",
        seats: { reviewer_a: "zorp", reviewer_b: "pending" },
        started_at: "2026-04-19T00:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("state/types — .lock zod schema (SPEC §8)", () => {
  test("accepts a minimal lock record", () => {
    const parsed = lockSchema.parse({
      pid: 4242,
      started_at: "2026-04-19T00:00:00.000Z",
      slug: "demo",
    });
    expect(parsed.pid).toBe(4242);
  });

  test("rejects a non-integer pid", () => {
    expect(() =>
      lockSchema.parse({
        pid: 4242.5,
        started_at: "2026-04-19T00:00:00.000Z",
        slug: "demo",
      }),
    ).toThrow();
  });

  test("rejects a negative pid", () => {
    expect(() =>
      lockSchema.parse({
        pid: -1,
        started_at: "2026-04-19T00:00:00.000Z",
        slug: "demo",
      }),
    ).toThrow();
  });

  test("rejects an empty slug", () => {
    expect(() =>
      lockSchema.parse({
        pid: 4242,
        started_at: "2026-04-19T00:00:00.000Z",
        slug: "",
      }),
    ).toThrow();
  });
});
