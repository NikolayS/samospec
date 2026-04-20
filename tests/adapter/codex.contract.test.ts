// Copyright 2026 Nikolay Samokhvalov.

// Drives CodexAdapter through the shared contract helper
// (SPEC §13 test 4). The adapter is wired to the fake-CLI harness
// via an injected spawn. Fixtures live under
// tests/fixtures/codex-fixtures/.

import { afterAll, describe, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { CodexAdapter } from "../../src/adapter/codex.ts";
import { runAdapterContract } from "../../src/adapter/contract-test.ts";
import {
  spawnCli,
  type SpawnCliInput,
  type SpawnCliResult,
} from "../../src/adapter/spawn.ts";

const FAKE_CLI = new URL("../fixtures/fake-cli.ts", import.meta.url).pathname;
const BUN_DIR = dirname(process.execPath);

function codexFixture(name: string): string {
  return new URL(`../fixtures/codex-fixtures/${name}`, import.meta.url).pathname;
}

const TMP: string[] = [];

afterAll(() => {
  for (const d of TMP) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeHost(): Record<string, string | undefined> {
  const stateDir = mkdtempSync(join(tmpdir(), "samospec-codex-contract-"));
  TMP.push(stateDir);
  const binDir = mkdtempSync(join(tmpdir(), "samospec-codex-contract-bin-"));
  TMP.push(binDir);
  const binPath = join(binDir, "codex");
  writeFileSync(binPath, "#!/usr/bin/env bash\necho 0.41.0\n");
  Bun.spawnSync(["chmod", "+x", binPath]);
  return {
    PATH: `${BUN_DIR}:${binDir}`,
    HOME: stateDir,
    TMPDIR: stateDir,
  };
}

/**
 * Spawn delegator that forwards work-call spawns to the fake-CLI
 * harness, keyed by a per-adapter state file so response branches
 * advance. Detect (--version) spawns are satisfied inline so they
 * don't consume a branch.
 */
function makeDelegator(
  fixture: string,
): (i: SpawnCliInput) => Promise<SpawnCliResult> {
  const stateDir = mkdtempSync(join(tmpdir(), "samospec-codex-contract-state-"));
  TMP.push(stateDir);
  const stateFile = join(stateDir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ call: 0 }));

  return async (input: SpawnCliInput): Promise<SpawnCliResult> => {
    // Intercept --version probes so they don't consume a branch.
    if (input.cmd.includes("--version")) {
      return {
        ok: true,
        exitCode: 0,
        stdout: "codex-cli 0.41.0\n",
        stderr: "",
      };
    }
    const env: Record<string, string | undefined> = {
      ...input.env,
      FAKE_CLI_FIXTURE: fixture,
      FAKE_CLI_STATE_FILE: stateFile,
    };
    const rewritten: SpawnCliInput = {
      cmd: ["bun", "run", FAKE_CLI],
      stdin: input.stdin,
      env,
      timeoutMs: input.timeoutMs,
      extraAllowedEnvKeys: [
        ...(input.extraAllowedEnvKeys ?? []),
        "FAKE_CLI_FIXTURE",
        "FAKE_CLI_STATE_FILE",
      ],
      ...(input.host !== undefined ? { host: input.host } : {}),
    };
    return await spawnCli(rewritten);
  };
}

describe("CodexAdapter — shared contract (SPEC §13 test 4)", () => {
  test("passes the full contract suite via fake-CLI trio fixture", async () => {
    await runAdapterContract({
      name: "codex",
      makeAdapter: () =>
        new CodexAdapter({
          host: makeHost(),
          spawn: makeDelegator(codexFixture("contract-trio.json")),
        }),
    });
  });
});
