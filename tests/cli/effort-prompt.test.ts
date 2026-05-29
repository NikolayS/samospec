// Copyright 2026 Nikolay Samokhvalov.

// Interactive effort prompt gate (samospec robustness pass).
//
// The CLI prompts for effort ONLY when:
//   - stdin is a TTY, AND
//   - no `--effort` flag was passed, AND
//   - config doesn't pin any seat's effort, AND
//   - we are NOT in a non-interactive context (`--yes` / `--no-interactive`
//     / jsonl / piped stdin).
//
// Otherwise the prompt is skipped and per-seat config / unified high
// default apply. The chosen level overrides every seat uniformly.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveSeatEffortsWithPrompt } from "../../src/cli.ts";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "samospec-effort-prompt-"));
}

function writeConfig(cwd: string, config: unknown): void {
  mkdirSync(join(cwd, ".samo"), { recursive: true });
  writeFileSync(
    join(cwd, ".samo", "config.json"),
    JSON.stringify(config, null, 2),
  );
}

describe("resolveSeatEffortsWithPrompt — interactive gate", () => {
  test("prompts in a TTY with no flag and no config pin; choice overrides all seats", async () => {
    let prompted = 0;
    const efforts = await resolveSeatEffortsWithPrompt({
      cwd: tmpRepo(),
      stdinIsTty: true,
      nonInteractive: false,
      promptFn: () => {
        prompted += 1;
        return Promise.resolve("low");
      },
    });
    expect(prompted).toBe(1);
    expect(efforts).toEqual({
      lead: "low",
      reviewer_a: "low",
      reviewer_b: "low",
    });
  });

  test("empty prompt answer -> high default for all seats", async () => {
    const efforts = await resolveSeatEffortsWithPrompt({
      cwd: tmpRepo(),
      stdinIsTty: true,
      nonInteractive: false,
      promptFn: () => Promise.resolve(""),
    });
    expect(efforts).toEqual({
      lead: "high",
      reviewer_a: "high",
      reviewer_b: "high",
    });
  });

  test("does NOT prompt when --effort flag is supplied (flag wins, all seats)", async () => {
    let prompted = 0;
    const efforts = await resolveSeatEffortsWithPrompt({
      cwd: tmpRepo(),
      flagEffort: "max",
      stdinIsTty: true,
      nonInteractive: false,
      promptFn: () => {
        prompted += 1;
        return Promise.resolve("low");
      },
    });
    expect(prompted).toBe(0);
    expect(efforts).toEqual({
      lead: "max",
      reviewer_a: "max",
      reviewer_b: "max",
    });
  });

  test("does NOT prompt when config pins a seat's effort", async () => {
    const cwd = tmpRepo();
    writeConfig(cwd, { adapters: { lead: { effort: "low" } } });
    let prompted = 0;
    const efforts = await resolveSeatEffortsWithPrompt({
      cwd,
      stdinIsTty: true,
      nonInteractive: false,
      promptFn: () => {
        prompted += 1;
        return Promise.resolve("off");
      },
    });
    expect(prompted).toBe(0);
    // Config value for lead, high for the unpinned seats.
    expect(efforts).toEqual({
      lead: "low",
      reviewer_a: "high",
      reviewer_b: "high",
    });
  });

  test("does NOT prompt under --yes / non-interactive (uses high default)", async () => {
    let prompted = 0;
    const efforts = await resolveSeatEffortsWithPrompt({
      cwd: tmpRepo(),
      stdinIsTty: true,
      nonInteractive: true,
      promptFn: () => {
        prompted += 1;
        return Promise.resolve("low");
      },
    });
    expect(prompted).toBe(0);
    expect(efforts).toEqual({
      lead: "high",
      reviewer_a: "high",
      reviewer_b: "high",
    });
  });

  test("does NOT prompt when stdin is not a TTY (piped/CI)", async () => {
    let prompted = 0;
    const efforts = await resolveSeatEffortsWithPrompt({
      cwd: tmpRepo(),
      stdinIsTty: false,
      nonInteractive: false,
      promptFn: () => {
        prompted += 1;
        return Promise.resolve("low");
      },
    });
    expect(prompted).toBe(0);
    expect(efforts.lead).toBe("high");
  });

  test("does NOT prompt when no promptFn is provided", async () => {
    const efforts = await resolveSeatEffortsWithPrompt({
      cwd: tmpRepo(),
      stdinIsTty: true,
      nonInteractive: false,
    });
    expect(efforts.lead).toBe("high");
  });
});
