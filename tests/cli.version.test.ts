// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.ts";
import packageJson from "../package.json" with { type: "json" };

describe("samospec version", () => {
  test("prints the package.json version to stdout and exits 0", () => {
    const result = runCli(["version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
    expect(result.stderr).toBe("");
  });

  test("responds to the -v short flag identically to version", () => {
    const long = runCli(["version"]);
    const short = runCli(["-v"]);

    expect(short.exitCode).toBe(0);
    expect(short.stdout).toBe(long.stdout);
  });

  test("responds to the --version long flag identically to version", () => {
    const subcommand = runCli(["version"]);
    const flag = runCli(["--version"]);

    expect(flag.exitCode).toBe(0);
    expect(flag.stdout).toBe(subcommand.stdout);
  });
});
