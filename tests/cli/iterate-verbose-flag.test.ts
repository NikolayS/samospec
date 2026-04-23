// Copyright 2026 Nikolay Samokhvalov.

// Issue #128 — `samospec iterate --verbose` errored with
// "unknown flag '--verbose'" because ITERATE_ALLOWED_FLAGS lacked
// the entry. `samospec new` has --verbose; iterate is verbose by default
// but should accept the flag as a no-op alias so muscle-memory works.

import { describe, expect, test } from "bun:test";

import { runCli } from "../../src/cli.ts";

describe("iterate parser — --verbose accepted as no-op (#128)", () => {
  test("--verbose alone does not produce 'unknown flag' error", async () => {
    // Feed a nonexistent slug so the run aborts at the
    // state-missing gate ("no spec found"), not at the parser.
    const res = await runCli(["iterate", "missing-slug", "--verbose"]);
    expect(res.stderr.toLowerCase()).not.toContain("unknown flag");
    expect(res.stderr.toLowerCase()).toContain("no spec found");
    expect(res.exitCode).toBe(1);
  });

  test("--verbose combined with --quiet does not produce 'unknown flag'", async () => {
    const res = await runCli([
      "iterate",
      "missing-slug",
      "--verbose",
      "--quiet",
    ]);
    expect(res.stderr.toLowerCase()).not.toContain("unknown flag");
    expect(res.stderr.toLowerCase()).toContain("no spec found");
    expect(res.exitCode).toBe(1);
  });
});
