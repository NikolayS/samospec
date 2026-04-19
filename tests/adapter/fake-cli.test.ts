// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import { spawnCli } from "../../src/adapter/spawn.ts";

const FAKE_CLI = new URL("../fixtures/fake-cli.ts", import.meta.url).pathname;

function fixture(name: string): string {
  return new URL(`../fixtures/fake-cli-fixtures/${name}`, import.meta.url)
    .pathname;
}

describe("fake-cli harness (SPEC §7)", () => {
  test("happy: stdin passes through, scripted stdout is returned", async () => {
    const result = await spawnCli({
      cmd: ["bun", "run", FAKE_CLI],
      stdin: "hello",
      env: { FAKE_CLI_FIXTURE: fixture("happy.json") },
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("pong");
    }
  });

  test("fenced: fixture emits ```json-wrapped payload", async () => {
    const result = await spawnCli({
      cmd: ["bun", "run", FAKE_CLI],
      stdin: "",
      env: { FAKE_CLI_FIXTURE: fixture("markdown-fenced.json") },
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stdout.startsWith("```json\n")).toBe(true);
      expect(result.stdout.trimEnd().endsWith("```")).toBe(true);
    }
  });

  test("timeout: fixture with sleep exceeds timeoutMs", async () => {
    const result = await spawnCli({
      cmd: ["bun", "run", FAKE_CLI],
      stdin: "",
      env: { FAKE_CLI_FIXTURE: fixture("timeout.json") },
      timeoutMs: 200,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
    }
  });

  test("minimal-env: does not forward arbitrary host env vars", async () => {
    const result = await spawnCli({
      cmd: ["bun", "run", FAKE_CLI],
      stdin: "",
      env: { FAKE_CLI_FIXTURE: fixture("echo-env.json") },
      timeoutMs: 5000,
      extraAllowedEnvKeys: ["FAKE_CLI_FIXTURE"],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The echo-env fixture prints JSON listing env keys it sees.
      const parsed = JSON.parse(result.stdout) as { keys: string[] };
      // Host secret should NOT leak:
      expect(parsed.keys).not.toContain("ANTHROPIC_API_KEY_TEST_MARKER");
      // Explicit allowed key must be present:
      expect(parsed.keys).toContain("FAKE_CLI_FIXTURE");
      // Baseline env (PATH/HOME) may or may not be present depending
      // on host — we don't assert on those here.
    }
  });

  test("schema-violate-then-repair: first call emits garbage, second emits clean JSON", async () => {
    // Drives the repair-retry path: adapter-level retry on schema_violation.
    const stateFile = fixture("schema-violate-repair.state.json");
    // Reset state for determinism.
    await Bun.write(stateFile, JSON.stringify({ call: 0 }));

    const first = await spawnCli({
      cmd: ["bun", "run", FAKE_CLI],
      stdin: "",
      env: {
        FAKE_CLI_FIXTURE: fixture("schema-violate-repair.json"),
        FAKE_CLI_STATE_FILE: stateFile,
      },
      timeoutMs: 5000,
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.stdout).not.toContain('"ok":true');
    }

    const second = await spawnCli({
      cmd: ["bun", "run", FAKE_CLI],
      stdin: "",
      env: {
        FAKE_CLI_FIXTURE: fixture("schema-violate-repair.json"),
        FAKE_CLI_STATE_FILE: stateFile,
      },
      timeoutMs: 5000,
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.stdout).toContain('"ok":true');
    }
  });

  test("schema-fatal: every call emits garbage", async () => {
    const result = await spawnCli({
      cmd: ["bun", "run", FAKE_CLI],
      stdin: "",
      env: { FAKE_CLI_FIXTURE: fixture("schema-fatal.json") },
      timeoutMs: 5000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => {
        JSON.parse(result.stdout);
      }).toThrow();
    }
  });
});
