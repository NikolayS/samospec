// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.ts";

describe("samospec CLI error paths", () => {
  test("exits 1 with usage on stderr when no command is given", async () => {
    const result = await runCli([]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Usage: samospec");
    expect(result.stderr).toContain("version");
  });

  test("exits 1 with an unknown-command message on stderr", async () => {
    const result = await runCli(["frobnicate"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown command 'frobnicate'");
    expect(result.stderr).toContain("Usage: samospec");
  });

  test("unknown-command handling is case-sensitive", async () => {
    const result = await runCli(["VERSION"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown command 'VERSION'");
  });

  test("usage block advertises iterate and status", async () => {
    const result = await runCli([]);
    expect(result.stderr).toContain("iterate");
    expect(result.stderr).toContain("status");
  });

  test("samospec iterate without slug exits 1 with usage", async () => {
    const result = await runCli(["iterate"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing <slug>");
  });

  test("samospec status without slug exits 1 with usage", async () => {
    const result = await runCli(["status"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("missing <slug>");
  });
});
