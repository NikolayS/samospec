#!/usr/bin/env bun
// Copyright 2026 Nikolay Samokhvalov.

import packageJson from "../package.json" with { type: "json" };

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const VERSION_FLAGS = new Set(["version", "-v", "--version"]);

export function runCli(argv: readonly string[]): CliResult {
  const [command] = argv;

  if (command !== undefined && VERSION_FLAGS.has(command)) {
    return {
      exitCode: 0,
      stdout: `${packageJson.version}\n`,
      stderr: "",
    };
  }

  const usage =
    "Usage: samospec <command>\n\n" +
    "Commands:\n" +
    "  version    Print the samospec version and exit.\n";

  if (command === undefined) {
    return { exitCode: 1, stdout: "", stderr: usage };
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: `samospec: unknown command '${command}'\n\n${usage}`,
  };
}

if (import.meta.main) {
  const result = runCli(Bun.argv.slice(2));
  if (result.stdout.length > 0) {
    Bun.write(Bun.stdout, result.stdout);
  }
  if (result.stderr.length > 0) {
    Bun.write(Bun.stderr, result.stderr);
  }
  process.exit(result.exitCode);
}
