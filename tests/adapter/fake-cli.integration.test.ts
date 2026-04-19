// Copyright 2026 Nikolay Samokhvalov.

// End-to-end: harness stdout -> JSON pre-parser -> validated output.
// Covers SPEC §7 Markdown-code-fence wrapping and the
// schema-violate-then-repair retry path.

import { describe, expect, test } from "bun:test";

import { preParseJson } from "../../src/adapter/json-parse.ts";
import { AskOutputSchema } from "../../src/adapter/types.ts";
import { spawnCli } from "../../src/adapter/spawn.ts";

const FAKE_CLI = new URL("../fixtures/fake-cli.ts", import.meta.url).pathname;
function fixture(name: string): string {
  return new URL(`../fixtures/fake-cli-fixtures/${name}`, import.meta.url)
    .pathname;
}

describe("fake-cli -> pre-parser -> zod (§7 integration)", () => {
  test("markdown-fenced JSON is stripped and validated", async () => {
    const result = await spawnCli({
      cmd: ["bun", "run", FAKE_CLI],
      stdin: "",
      env: { FAKE_CLI_FIXTURE: fixture("markdown-fenced.json") },
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = preParseJson(result.stdout);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.stripped).toBe(true);

    const validated = AskOutputSchema.parse(parsed.value);
    expect(validated.usage).toBeNull();
    expect(validated.effort_used).toBe("max");
  });

  test("double-fenced output fails pre-parser (single-pair strip only)", async () => {
    const result = await spawnCli({
      cmd: ["bun", "run", FAKE_CLI],
      stdin: "",
      env: { FAKE_CLI_FIXTURE: fixture("double-fenced-fails.json") },
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = preParseJson(result.stdout);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.kind).toBe("schema_violation");
  });

  test("schema-fatal output fails pre-parser", async () => {
    const result = await spawnCli({
      cmd: ["bun", "run", FAKE_CLI],
      stdin: "",
      env: { FAKE_CLI_FIXTURE: fixture("schema-fatal.json") },
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = preParseJson(result.stdout);
    expect(parsed.ok).toBe(false);
  });
});
