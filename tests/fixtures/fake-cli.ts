#!/usr/bin/env bun
// Copyright 2026 Nikolay Samokhvalov.

// Fake-CLI harness (SPEC §7).
//
// Reads the prompt payload from stdin (unused by most fixtures) and
// emits a scripted stdout pattern driven by the JSON fixture at
// FAKE_CLI_FIXTURE. Supports a stateful mode via FAKE_CLI_STATE_FILE
// for "schema-violate-then-repair" testing where the Nth call changes
// behavior.
//
// Fixture schema:
//   {
//     "script": [
//       { "type": "sleep", "ms": <number> },
//       { "type": "stdout", "text": "<string>" },
//       { "type": "stderr", "text": "<string>" },
//       { "type": "env_keys", "filter_prefix": "<string>" },
//       { "type": "exit", "code": <number> }
//     ]
//   }
//
// Stateful fixtures append a top-level "branches" map:
//   {
//     "branches": {
//       "0": { "script": [...] },   // first call
//       "default": { "script": [...] }
//     }
//   }
// and the harness reads/writes a { "call": <n> } state file.

import { readFileSync, writeFileSync, existsSync } from "node:fs";

interface SleepStep {
  readonly type: "sleep";
  readonly ms: number;
}
interface StdoutStep {
  readonly type: "stdout";
  readonly text: string;
}
interface StderrStep {
  readonly type: "stderr";
  readonly text: string;
}
interface EnvKeysStep {
  readonly type: "env_keys";
  readonly filter_prefix?: string;
}
interface ExitStep {
  readonly type: "exit";
  readonly code: number;
}
type Step = SleepStep | StdoutStep | StderrStep | EnvKeysStep | ExitStep;

interface Fixture {
  readonly script?: readonly Step[];
  readonly branches?: Readonly<
    Record<string, { readonly script: readonly Step[] }>
  >;
}

function readState(path: string): { call: number } {
  if (!existsSync(path)) return { call: 0 };
  const raw = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(raw) as { call?: number };
    return { call: typeof parsed.call === "number" ? parsed.call : 0 };
  } catch {
    return { call: 0 };
  }
}

function writeState(path: string, state: { call: number }): void {
  writeFileSync(path, JSON.stringify(state));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runScript(script: readonly Step[]): Promise<number> {
  let exitCode = 0;
  for (const step of script) {
    switch (step.type) {
      case "sleep":
        await sleep(step.ms);
        break;
      case "stdout":
        process.stdout.write(step.text);
        break;
      case "stderr":
        process.stderr.write(step.text);
        break;
      case "env_keys": {
        const prefix = step.filter_prefix ?? "";
        const keys = Object.keys(process.env)
          .filter((k) => prefix === "" || k.startsWith(prefix))
          .sort();
        process.stdout.write(JSON.stringify({ keys }));
        break;
      }
      case "exit":
        exitCode = step.code;
        break;
    }
  }
  return exitCode;
}

async function main(): Promise<void> {
  // Always drain stdin so tests that write prompts don't block us.
  // We don't use the content here, but reading keeps the pipe clean.
  try {
    const reader = Bun.stdin.stream().getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    // nothing to read — fine.
  }

  const fixturePath = process.env["FAKE_CLI_FIXTURE"];
  if (fixturePath === undefined || fixturePath === "") {
    process.stderr.write("fake-cli: FAKE_CLI_FIXTURE not set\n");
    process.exit(2);
  }

  let fixture: Fixture;
  try {
    fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
  } catch (err) {
    process.stderr.write(
      `fake-cli: failed to read fixture ${fixturePath}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    process.exit(2);
  }

  const statePath = process.env["FAKE_CLI_STATE_FILE"];
  let script: readonly Step[] | undefined;

  if (fixture.branches !== undefined && statePath !== undefined) {
    const state = readState(statePath);
    const branchKey = String(state.call);
    const branch = fixture.branches[branchKey] ?? fixture.branches["default"];
    if (branch === undefined) {
      process.stderr.write(`fake-cli: no branch for call=${branchKey}\n`);
      process.exit(2);
    }
    script = branch.script;
    writeState(statePath, { call: state.call + 1 });
  } else {
    script = fixture.script;
  }

  if (script === undefined) {
    process.stderr.write("fake-cli: fixture is missing `script`\n");
    process.exit(2);
  }

  const exitCode = await runScript(script);
  process.exit(exitCode);
}

await main();
