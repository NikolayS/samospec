// Copyright 2026 Nikolay Samokhvalov.

import { homedir } from "node:os";

import { createFakeAdapter } from "./adapter/fake-adapter.ts";
import { runInit } from "./cli/init.ts";
import { runDoctor, type DoctorAdapterBinding } from "./cli/doctor.ts";
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
  "  init       Create or refresh .samospec/ in the current repo.\n" +
  "  doctor     Diagnose CLI availability, auth, git, lock, and config.\n" +
  "  version    Print the samospec version and exit.\n";

/**
 * Default adapter bindings for `samospec doctor`. Sprint 1 only ships
 * the fake adapter (real adapters land in Sprint 2+). The fake's
 * default program is tuned to `installed: true` + `authenticated: true`
 * + `subscription_auth: true`, which realistically surfaces every
 * branch of the doctor output when invoked interactively.
 */
function defaultAdapterBindings(): readonly DoctorAdapterBinding[] {
  return [
    { label: "claude", adapter: createFakeAdapter() },
    { label: "codex", adapter: createFakeAdapter() },
  ];
}

/**
 * Dispatch subcommands. Returns a Promise so async subcommands (doctor)
 * can resolve; synchronous subcommands (version, init) are wrapped.
 */
export async function runCli(argv: readonly string[]): Promise<CliResult> {
  const [command, ...rest] = argv;

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

  if (command === "init") {
    // Sprint 1 init takes no flags; ignore unused args.
    void rest;
    return runInit({ cwd: process.cwd() });
  }

  if (command === "doctor") {
    void rest;
    return runDoctor({
      cwd: process.cwd(),
      homeDir: homedir(),
      adapters: defaultAdapterBindings(),
    });
  }

  return {
    exitCode: 1,
    stdout: "",
    stderr: `samospec: unknown command '${command}'\n\n${USAGE}`,
  };
}
