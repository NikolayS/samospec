// Copyright 2026 Nikolay Samokhvalov.

// Unified `--effort` CLI flag (samospec robustness pass).
//
// Covers the CLI-surface contract:
//   - `--effort` is documented in USAGE for `new` and `iterate`.
//   - A bad `--effort` value exits 2 (usage error) with a message that
//     names the valid set — distinct from the exit-1 "missing slug" path.
//   - Both the spaced (`--effort low`) and equals (`--effort=low`) forms
//     are validated.
//   - A valid `--effort` value does NOT trip the validation (it parses;
//     the failure modes below are about missing slug / downstream, not
//     the flag itself).

import { describe, expect, test } from "bun:test";

import { runCli } from "../../src/cli.ts";

describe("samospec --effort flag — USAGE", () => {
  test("USAGE documents --effort for new and iterate", async () => {
    const res = await runCli([]);
    expect(res.stderr).toContain("--effort <max|high|medium|low|off>");
    // It should appear under both command option blocks.
    const occurrences = res.stderr.split(
      "--effort <max|high|medium|low|off>",
    ).length;
    expect(occurrences).toBeGreaterThanOrEqual(3); // 2 doc blocks => 3 splits
  });

  test("USAGE states medium is the default and explains the precedence", async () => {
    const res = await runCli([]);
    expect(res.stderr).toContain(
      "--effort flag > adapters.<seat>.effort in config > medium",
    );
  });
});

describe("samospec new --effort — validation (exit 2)", () => {
  test("bad value exits 2 with a clear usage error", async () => {
    const res = await runCli(["new", "demo", "--effort", "turbo"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--effort must be one of");
    expect(res.stderr).toContain("max|high|medium|low|off");
    expect(res.stderr).toContain("turbo");
    expect(res.stderr).toContain("Usage: samospec");
  });

  test("bad value via equals form exits 2", async () => {
    const res = await runCli(["new", "demo", "--effort=nope"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--effort must be one of");
  });

  test("empty value exits 2", async () => {
    const res = await runCli(["new", "demo", "--effort", ""]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--effort must be one of");
  });

  test("validation fires before the missing-slug check (exit 2 not 1)", async () => {
    // No slug AND a bad effort: the effort validation wins (exit 2),
    // because it's a usage error regardless of the positional slug.
    const res = await runCli(["new", "--effort", "turbo"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--effort must be one of");
  });
});

describe("samospec iterate --effort — validation (exit 2)", () => {
  test("bad value exits 2 with a clear usage error", async () => {
    const res = await runCli(["iterate", "demo", "--effort", "ludicrous"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--effort must be one of");
    expect(res.stderr).toContain("ludicrous");
  });

  test("bad value via equals form exits 2", async () => {
    const res = await runCli(["iterate", "demo", "--effort=nope"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--effort must be one of");
  });

  test("--effort is on the iterate allow-list (not an unknown-flag error)", async () => {
    // A valid --effort must not trip the #91 unknown-flag rejection.
    // With a valid effort but a missing slug we still get the
    // missing-slug message (exit 1), proving --effort itself was
    // accepted by the allow-list.
    const res = await runCli(["iterate", "--effort", "low"]);
    expect(res.stderr).not.toContain("unknown flag");
  });
});
