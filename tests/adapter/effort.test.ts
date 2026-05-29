// Copyright 2026 Nikolay Samokhvalov.

// Unified effort resolution (samospec robustness pass).
//
// Locks down the documented precedence and the NEW unified default:
//
//   --effort flag  >  per-seat adapters.<seat>.effort  >  medium
//
// The default MUST be "medium" (a balanced average), NOT the historical
// "max" — that's the headline behavior change these tests guard.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EFFORT_PROMPT_CHOOSE,
  EFFORT_PROMPT_INTRO,
  UNIFIED_DEFAULT_EFFORT,
  effortIsPinned,
  parseEffortFlag,
  readSeatEfforts,
  resolveAllSeatEfforts,
  resolvePromptedEffort,
  resolveSeatEffort,
} from "../../src/adapter/effort.ts";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "samospec-effort-"));
}

function writeConfig(cwd: string, config: unknown): void {
  mkdirSync(join(cwd, ".samo"), { recursive: true });
  writeFileSync(
    join(cwd, ".samo", "config.json"),
    JSON.stringify(config, null, 2),
  );
}

describe("UNIFIED_DEFAULT_EFFORT", () => {
  test("is medium (NOT max)", () => {
    expect(UNIFIED_DEFAULT_EFFORT).toBe("medium");
    expect(UNIFIED_DEFAULT_EFFORT).not.toBe("max");
  });
});

describe("parseEffortFlag", () => {
  test.each(["max", "high", "medium", "low", "off"] as const)(
    "accepts valid level %s",
    (level) => {
      const r = parseEffortFlag(level);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(level);
    },
  );

  test("trims surrounding whitespace", () => {
    const r = parseEffortFlag("  high  ");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe("high");
  });

  test("rejects an unknown value with a message naming the valid set", () => {
    const r = parseEffortFlag("turbo");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("--effort must be one of");
      expect(r.error).toContain("max|high|medium|low|off");
      expect(r.error).toContain("turbo");
    }
  });

  test("rejects empty value", () => {
    const r = parseEffortFlag("");
    expect(r.ok).toBe(false);
  });

  test("rejects case variants (enum is exact)", () => {
    const r = parseEffortFlag("MAX");
    expect(r.ok).toBe(false);
  });
});

describe("resolveSeatEffort — precedence", () => {
  test("flag wins over config", () => {
    expect(resolveSeatEffort("low", "max")).toBe("low");
  });

  test("config wins over default when no flag", () => {
    expect(resolveSeatEffort(undefined, "high")).toBe("high");
  });

  test("falls back to medium default when neither flag nor config", () => {
    expect(resolveSeatEffort(undefined, undefined)).toBe("medium");
  });
});

describe("readSeatEfforts", () => {
  test("returns {} when no config file", () => {
    expect(readSeatEfforts(tmpRepo())).toEqual({});
  });

  test("reads valid per-seat effort values", () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: {
        lead: { effort: "high" },
        reviewer_a: { effort: "low" },
        reviewer_b: { effort: "off" },
      },
    });
    expect(readSeatEfforts(cwd)).toEqual({
      lead: "high",
      reviewer_a: "low",
      reviewer_b: "off",
    });
  });

  test("ignores invalid effort strings for a seat", () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: { lead: { effort: "turbo" }, reviewer_a: { effort: "low" } },
    });
    expect(readSeatEfforts(cwd)).toEqual({ reviewer_a: "low" });
  });

  test("tolerates malformed JSON", () => {
    const cwd = tmpRepo();
    mkdirSync(join(cwd, ".samo"), { recursive: true });
    writeFileSync(join(cwd, ".samo", "config.json"), "{ not json ");
    expect(readSeatEfforts(cwd)).toEqual({});
  });
});

describe("resolveAllSeatEfforts — unified knob", () => {
  test("flag overrides ALL seats uniformly, beating per-seat config", () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: {
        lead: { effort: "high" },
        reviewer_a: { effort: "low" },
        reviewer_b: { effort: "off" },
      },
    });
    const efforts = resolveAllSeatEfforts({ cwd, flagEffort: "max" });
    expect(efforts).toEqual({
      lead: "max",
      reviewer_a: "max",
      reviewer_b: "max",
    });
  });

  test("without flag, each seat uses its config value, else medium", () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: { lead: { effort: "high" } },
    });
    const efforts = resolveAllSeatEfforts({ cwd });
    expect(efforts).toEqual({
      lead: "high",
      reviewer_a: "medium",
      reviewer_b: "medium",
    });
  });

  test("no flag + no config -> medium everywhere", () => {
    const efforts = resolveAllSeatEfforts({ cwd: tmpRepo() });
    expect(efforts).toEqual({
      lead: "medium",
      reviewer_a: "medium",
      reviewer_b: "medium",
    });
  });
});

describe("effortIsPinned", () => {
  test("true when flag supplied", () => {
    expect(effortIsPinned({ cwd: tmpRepo(), flagEffort: "low" })).toBe(true);
  });

  test("true when any seat pinned in config", () => {
    const cwd = tmpRepo();
    writeConfig(cwd, { adapters: { reviewer_b: { effort: "max" } } });
    expect(effortIsPinned({ cwd })).toBe(true);
  });

  test("false when neither flag nor config pin effort", () => {
    expect(effortIsPinned({ cwd: tmpRepo() })).toBe(false);
  });
});

describe("interactive prompt copy", () => {
  test("intro explains the depth/speed tradeoff for each level", () => {
    expect(EFFORT_PROMPT_INTRO).toContain("Reasoning effort — depth vs speed");
    expect(EFFORT_PROMPT_INTRO).toContain("max");
    expect(EFFORT_PROMPT_INTRO).toContain("deepest review");
    expect(EFFORT_PROMPT_INTRO).toContain("medium — balanced (default)");
    expect(EFFORT_PROMPT_INTRO).toContain("minimal");
  });

  test("intro carries a per-level rough ETA", () => {
    expect(EFFORT_PROMPT_INTRO).toContain("~20-40 min/round"); // max
    expect(EFFORT_PROMPT_INTRO).toContain("~15-30 min/round"); // high
    expect(EFFORT_PROMPT_INTRO).toContain("~5-12 min/round"); // medium
    expect(EFFORT_PROMPT_INTRO).toContain("~2-5 min/round"); // low
    expect(EFFORT_PROMPT_INTRO).toContain("~1-2 min/round"); // off
  });

  test("intro carries the caveat that ETAs are rough and scale with spec size", () => {
    expect(EFFORT_PROMPT_INTRO).toContain("ETAs are rough");
    expect(EFFORT_PROMPT_INTRO).toContain("scale with spec size");
  });

  test("choose line advertises medium as default", () => {
    expect(EFFORT_PROMPT_CHOOSE).toContain("default medium");
    expect(EFFORT_PROMPT_CHOOSE).toContain("max/high/medium/low/off");
  });

  test("resolvePromptedEffort: empty -> medium default", () => {
    expect(resolvePromptedEffort("")).toBe("medium");
  });

  test("resolvePromptedEffort: valid value honored", () => {
    expect(resolvePromptedEffort("high")).toBe("high");
  });

  test("resolvePromptedEffort: unknown -> medium default (lenient)", () => {
    expect(resolvePromptedEffort("turbo")).toBe("medium");
  });
});
