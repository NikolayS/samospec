// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.ts";
import packageJson from "../package.json" with { type: "json" };

describe("samospec version", () => {
  test("prints the package.json version to stdout and exits 0", async () => {
    const result = await runCli(["version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
    expect(result.stderr).toBe("");
  });

  test("responds to the -v short flag identically to version", async () => {
    const long = await runCli(["version"]);
    const short = await runCli(["-v"]);

    expect(short.exitCode).toBe(0);
    expect(short.stdout).toBe(long.stdout);
  });

  test("responds to the --version long flag identically to version", async () => {
    const subcommand = await runCli(["version"]);
    const flag = await runCli(["--version"]);

    expect(flag.exitCode).toBe(0);
    expect(flag.stdout).toBe(subcommand.stdout);
  });
});
