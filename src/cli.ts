// Copyright 2026 Nikolay Samokhvalov.

import packageJson from "../package.json" with { type: "json" };

export interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const VERSION_FLAGS: ReadonlySet<string> = new Set([
  "version",
  "-v",
  "--version",
]);

const USAGE =
  "Usage: samospec <command>\n\n" +
  "Commands:\n" +
  "  version    Print the samospec version and exit.\n";

export function runCli(argv: readonly string[]): CliResult {
  const [command] = argv;

  if (command !== undefined && VERSION_FLAGS.has(command)) {
    return {
      exitCode: 0,
      stdout: `${packageJson.version}\n`,
      stderr: "",
    };
  }

  if (command === undefined) {
    return { exitCode: 1, stdout: "", stderr: USAGE };
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: `samospec: unknown command '${command}'\n\n${USAGE}`,
  };
}
