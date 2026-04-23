// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runInit,
  DEFAULT_CONFIG,
  CONFIG_SCHEMA_VERSION,
} from "../../src/cli/init.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-init-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("samospec init — fresh directory", () => {
  test("creates .samo/ with config.json, .gitignore, cache dirs and exits 0", () => {
    const result = runInit({ cwd: tmp });

    expect(result.exitCode).toBe(0);

    const samo = path.join(tmp, ".samo");
    expect(existsSync(samo)).toBe(true);
    expect(existsSync(path.join(samo, "config.json"))).toBe(true);
    expect(existsSync(path.join(samo, ".gitignore"))).toBe(true);
    expect(existsSync(path.join(samo, "cache"))).toBe(true);
    expect(existsSync(path.join(samo, "cache", "gists"))).toBe(true);
  });

  test("config.json is parseable JSON and contains v1 pinned defaults", () => {
    runInit({ cwd: tmp });
    const cfgPath = path.join(tmp, ".samo", "config.json");
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<
      string,
      unknown
    >;

    // Schema version tracked so migrations can run later.
    expect(parsed["schema_version"]).toBe(CONFIG_SCHEMA_VERSION);

    // Pinned lead adapter per SPEC §11.
    const adapters = parsed["adapters"] as Record<string, unknown>;
    const lead = adapters["lead"] as Record<string, unknown>;
    expect(lead["adapter"]).toBe("claude");
    expect(lead["model_id"]).toBe("claude-opus-4-7");
    expect(lead["effort"]).toBe("max");

    const reviewerA = adapters["reviewer_a"] as Record<string, unknown>;
    expect(reviewerA["adapter"]).toBe("codex");
    expect(reviewerA["model_id"]).toBe("gpt-5.4");
    expect(reviewerA["effort"]).toBe("max");
    // Regression guard: stale 5.1-codex-max must NOT appear (#130).
    expect(reviewerA["model_id"]).not.toContain("5.1-codex");
    const fallback = reviewerA["fallback_chain"] as string[];
    expect(fallback[0]).toBe("gpt-5.4");
    expect(fallback).toContain("gpt-5.3-codex");

    const reviewerB = adapters["reviewer_b"] as Record<string, unknown>;
    expect(reviewerB["adapter"]).toBe("claude");
    expect(reviewerB["model_id"]).toBe("claude-opus-4-7");
    expect(reviewerB["effort"]).toBe("max");

    // Budget defaults per SPEC §11.
    const budget = parsed["budget"] as Record<string, unknown>;
    expect(budget["max_tokens_per_round"]).toBe(250_000);
    expect(budget["max_total_tokens_per_session"]).toBe(2_000_000);
    expect(budget["max_wall_clock_minutes"]).toBe(240);
    expect(budget["preflight_confirm_usd"]).toBe(20);

    // Git remote probe disabled by default (§14).
    const git = parsed["git"] as Record<string, unknown>;
    expect(git["remote_probe"]).toBe(false);
  });

  test(".gitignore ignores transcripts/, cache/, and .lock", () => {
    runInit({ cwd: tmp });
    const body = readFileSync(path.join(tmp, ".samo", ".gitignore"), "utf8");
    expect(body).toContain("transcripts/");
    expect(body).toContain("cache/");
    expect(body).toContain(".lock");
  });

  test("stdout announces creation of .samo/", () => {
    const result = runInit({ cwd: tmp });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(".samo");
    expect(result.stdout.toLowerCase()).toMatch(/created|initialized/);
  });

  test("DEFAULT_CONFIG exports a pinned-defaults constant for reuse", () => {
    expect(DEFAULT_CONFIG.schema_version).toBe(CONFIG_SCHEMA_VERSION);
    expect(DEFAULT_CONFIG.adapters.lead.model_id).toBe("claude-opus-4-7");
  });
});

describe("samospec init — idempotent re-run", () => {
  test("re-running preserves user-set keys and fills missing defaults", () => {
    runInit({ cwd: tmp });
    const cfgPath = path.join(tmp, ".samo", "config.json");

    // User edits config.json.
    const initial = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<
      string,
      unknown
    >;
    (initial["budget"] as Record<string, unknown>)["max_wall_clock_minutes"] =
      90;
    (initial["adapters"] as Record<string, Record<string, unknown>>)["lead"][
      "effort"
    ] = "high";
    // User adds a custom key — must be preserved.
    initial["custom_user_key"] = { hello: "world" };
    writeFileSync(cfgPath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");

    // Simulate a missing defaults-only key by deleting a budget field.
    const afterEdit = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete (afterEdit["budget"] as Record<string, unknown>)[
      "preflight_confirm_usd"
    ];
    writeFileSync(cfgPath, `${JSON.stringify(afterEdit, null, 2)}\n`, "utf8");

    const result = runInit({ cwd: tmp });

    expect(result.exitCode).toBe(0);
    const after = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<
      string,
      unknown
    >;

    // User overrides preserved.
    expect(
      (after["budget"] as Record<string, unknown>)["max_wall_clock_minutes"],
    ).toBe(90);
    expect(
      (after["adapters"] as Record<string, Record<string, unknown>>)["lead"][
        "effort"
      ],
    ).toBe("high");
    expect(after["custom_user_key"]).toEqual({ hello: "world" });

    // Missing default filled back in.
    expect(
      (after["budget"] as Record<string, unknown>)["preflight_confirm_usd"],
    ).toBe(20);
  });

  test("re-running prints a diff of what changed", () => {
    runInit({ cwd: tmp });
    const cfgPath = path.join(tmp, ".samo", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete (cfg["budget"] as Record<string, unknown>)["preflight_confirm_usd"];
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

    const result = runInit({ cwd: tmp });
    expect(result.exitCode).toBe(0);
    // Diff mentions the key that was filled back.
    expect(result.stdout).toContain("preflight_confirm_usd");
    // Some "added" / "changed" / "merge" marker.
    expect(result.stdout.toLowerCase()).toMatch(
      /added|changed|merged|filled|updated/,
    );
  });

  test("second identical re-run prints a no-changes message and exits 0", () => {
    runInit({ cwd: tmp });
    const result = runInit({ cwd: tmp });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toMatch(
      /no changes|up to date|unchanged/,
    );
  });
});

describe("samospec init — malformed existing config", () => {
  test("malformed config.json exits 1 with a clear message and does NOT overwrite", () => {
    mkdirSync(path.join(tmp, ".samo"), { recursive: true });
    const cfgPath = path.join(tmp, ".samo", "config.json");
    const garbage = "{ this is not valid json,, ";
    writeFileSync(cfgPath, garbage, "utf8");

    const result = runInit({ cwd: tmp });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toMatch(
      /malformed|invalid|cannot parse|parse error/,
    );
    // The file is NOT silently repaired.
    expect(readFileSync(cfgPath, "utf8")).toBe(garbage);
  });

  test("malformed config.json error suggests a remediation path", () => {
    mkdirSync(path.join(tmp, ".samo"), { recursive: true });
    const cfgPath = path.join(tmp, ".samo", "config.json");
    writeFileSync(cfgPath, "{ broken", "utf8");

    const result = runInit({ cwd: tmp });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("config.json");
  });
});

describe("samospec init — pre-existing .samo with no config.json", () => {
  test("creates config.json without clobbering existing sibling files", () => {
    const samo = path.join(tmp, ".samo");
    mkdirSync(samo, { recursive: true });
    writeFileSync(path.join(samo, "NOTES.md"), "user notes\n", "utf8");

    const result = runInit({ cwd: tmp });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(path.join(samo, "NOTES.md"), "utf8")).toBe(
      "user notes\n",
    );
    expect(existsSync(path.join(samo, "config.json"))).toBe(true);
  });
});
