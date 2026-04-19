// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ROUND_TRANSITIONS,
  RoundTransitionError,
  applyRoundTransition,
  isLegalRoundTransition,
  newRound,
  readRound,
  roundDirFor,
  writeRound,
} from "../../src/state/round.ts";
import {
  ROUND_STATES,
  type Round,
  type RoundState,
} from "../../src/state/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-round-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("state/round — transition table (SPEC §7)", () => {
  test("ROUND_TRANSITIONS matches the SPEC §7 table exactly", () => {
    // From SPEC §7 round state machine:
    // planned -> running
    // running -> reviews_collected | lead_terminal | running (retry-in-place)
    // reviews_collected -> lead_revised | lead_terminal
    // lead_revised -> committed | lead_terminal
    // committed -> planned (start next round)
    // lead_terminal is terminal (no outgoing)
    const asSet = (xs: readonly RoundState[]): Set<RoundState> => new Set(xs);
    expect(asSet(ROUND_TRANSITIONS.planned)).toEqual(asSet(["running"]));
    expect(asSet(ROUND_TRANSITIONS.running)).toEqual(
      asSet(["reviews_collected", "lead_terminal", "running"]),
    );
    expect(asSet(ROUND_TRANSITIONS.reviews_collected)).toEqual(
      asSet(["lead_revised", "lead_terminal"]),
    );
    expect(asSet(ROUND_TRANSITIONS.lead_revised)).toEqual(
      asSet(["committed", "lead_terminal"]),
    );
    expect(asSet(ROUND_TRANSITIONS.committed)).toEqual(asSet(["planned"]));
    expect(ROUND_TRANSITIONS.lead_terminal).toEqual([]);
  });

  test("isLegalRoundTransition accepts every entry in the table", () => {
    for (const from of ROUND_STATES) {
      const targets = ROUND_TRANSITIONS[from];
      for (const to of targets) {
        expect(isLegalRoundTransition(from, to)).toBe(true);
      }
    }
  });

  test("isLegalRoundTransition rejects any pair not in the table", () => {
    for (const from of ROUND_STATES) {
      const allowed = new Set<RoundState>(ROUND_TRANSITIONS[from]);
      for (const to of ROUND_STATES) {
        if (allowed.has(to)) continue;
        expect(isLegalRoundTransition(from, to)).toBe(false);
      }
    }
  });

  test("lead_terminal has no outgoing transitions", () => {
    for (const to of ROUND_STATES) {
      expect(isLegalRoundTransition("lead_terminal", to)).toBe(false);
    }
  });
});

describe("state/round — applyRoundTransition", () => {
  const base = {
    slug: "demo",
    phase: "review_loop" as const,
    round_index: 1,
    version: "0.1.0",
    persona: null,
    push_consent: null,
    calibration: null,
    remote_stale: false,
    coupled_fallback: false,
    round_state: "planned" as const,
    exit: null,
    created_at: "2026-04-19T00:00:00.000Z",
    updated_at: "2026-04-19T00:00:00.000Z",
  };

  test("legal transition bumps round_state and updated_at", () => {
    const after = applyRoundTransition(base, "running", {
      now: "2026-04-19T00:01:00.000Z",
    });
    expect(after.round_state).toBe("running");
    expect(after.updated_at).toBe("2026-04-19T00:01:00.000Z");
    expect(after.round_index).toBe(1);
  });

  test("committed -> planned bumps round_index by 1", () => {
    const before = { ...base, round_state: "committed" as const };
    const after = applyRoundTransition(before, "planned", {
      now: "2026-04-19T00:02:00.000Z",
    });
    expect(after.round_state).toBe("planned");
    expect(after.round_index).toBe(2);
  });

  test("illegal transition throws RoundTransitionError", () => {
    expect(() =>
      applyRoundTransition(base, "committed", {
        now: "2026-04-19T00:02:00.000Z",
      }),
    ).toThrow(RoundTransitionError);
  });

  test("lead_terminal is absorbing — no outgoing transition succeeds", () => {
    const terminal = { ...base, round_state: "lead_terminal" as const };
    for (const to of ROUND_STATES) {
      expect(() =>
        applyRoundTransition(terminal, to, {
          now: "2026-04-19T00:03:00.000Z",
        }),
      ).toThrow(RoundTransitionError);
    }
  });
});

describe("state/round — round.json sidecar (SPEC §7)", () => {
  test("newRound returns a planned round with both seats pending", () => {
    const r = newRound({ round: 3, now: "2026-04-19T01:00:00.000Z" });
    expect(r).toEqual({
      round: 3,
      status: "planned",
      seats: { reviewer_a: "pending", reviewer_b: "pending" },
      started_at: "2026-04-19T01:00:00.000Z",
    });
  });

  test("roundDirFor formats the rNN directory per SPEC §9", () => {
    expect(roundDirFor("/specs/demo/reviews", 1)).toBe(
      "/specs/demo/reviews/r01",
    );
    expect(roundDirFor("/specs/demo/reviews", 12)).toBe(
      "/specs/demo/reviews/r12",
    );
  });

  test("writeRound + readRound round-trip a round record", () => {
    const file = path.join(tmp, "r01", "round.json");
    const r: Round = newRound({
      round: 1,
      now: "2026-04-19T02:00:00.000Z",
    });
    writeRound(file, r);
    const loaded = readRound(file);
    expect(loaded).toEqual(r);
  });

  test("readRound returns null on missing file", () => {
    const file = path.join(tmp, "missing.json");
    expect(readRound(file)).toBeNull();
  });

  test("readRound throws on malformed JSON", () => {
    const file = path.join(tmp, "round.json");
    writeFileSync(file, "not json", "utf8");
    expect(() => readRound(file)).toThrow(/round\.json/);
  });

  test("readRound throws on schema violation", () => {
    const file = path.join(tmp, "round.json");
    writeFileSync(file, JSON.stringify({ round: 1, status: "???" }), "utf8");
    expect(() => readRound(file)).toThrow(/round\.json/);
  });

  test("writeRound is atomic: no .tmp sibling left behind on success", () => {
    const dir = path.join(tmp, "atomic");
    const file = path.join(dir, "round.json");
    const r = newRound({ round: 1, now: "2026-04-19T03:00:00.000Z" });
    writeRound(file, r);
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(dir)).toEqual(["round.json"]);
  });

  test("writeRound refuses an invalid round record", () => {
    const file = path.join(tmp, "round.json");
    const bogus = {
      round: 0,
      status: "planned",
      seats: { reviewer_a: "pending", reviewer_b: "pending" },
      started_at: "2026-04-19T00:00:00.000Z",
    } as unknown as Round;
    expect(() => writeRound(file, bogus)).toThrow(/round/i);
  });
});
