// Copyright 2026 Nikolay Samokhvalov.

// Lifecycle tests for the Codex adapter (SPEC §7, §11, §13 test 4).
// Mirrors tests/adapter/claude.test.ts but for the `codex` CLI and the
// Reviewer A seat.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAdapter } from "../../src/adapter/codex.ts";

const TMP_DIRS: string[] = [];

function makeEmptyPathDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "samospec-codex-empty-path-"));
  TMP_DIRS.push(dir);
  return dir;
}

function makeFakeBinaryDir(
  name: string,
  script: string,
): { dir: string; binary: string } {
  const dir = mkdtempSync(join(tmpdir(), "samospec-codex-fake-bin-"));
  TMP_DIRS.push(dir);
  const binary = join(dir, name);
  writeFileSync(binary, `#!/usr/bin/env bash\n${script}\n`);
  chmodSync(binary, 0o755);
  return { dir, binary };
}

afterAll(() => {
  for (const d of TMP_DIRS) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("CodexAdapter — lifecycle (SPEC §7, §11)", () => {
  test("vendor is 'codex'", () => {
    const adapter = new CodexAdapter();
    expect(adapter.vendor).toBe("codex");
  });

  test("detect() returns { installed: false } when PATH has no codex binary", async () => {
    const emptyDir = makeEmptyPathDir();
    const adapter = new CodexAdapter({
      host: { PATH: emptyDir, HOME: "/tmp" },
    });
    const result = await adapter.detect();
    expect(result.installed).toBe(false);
  });

  test("detect() returns { installed: true, version, path } when codex binary exists", async () => {
    const { dir, binary } = makeFakeBinaryDir(
      "codex",
      'echo "codex-cli 0.41.0"',
    );
    const adapter = new CodexAdapter({
      host: { PATH: `${dir}:/bin:/usr/bin`, HOME: "/tmp" },
    });
    const result = await adapter.detect();
    expect(result.installed).toBe(true);
    if (result.installed) {
      expect(result.version).toBe("0.41.0");
      expect(result.path).toBe(binary);
    }
  });

  test("supports_structured_output() returns true", () => {
    const adapter = new CodexAdapter();
    expect(adapter.supports_structured_output()).toBe(true);
  });

  test("supports_effort() returns true for every effort level", () => {
    const adapter = new CodexAdapter();
    for (const level of ["max", "high", "medium", "low", "off"] as const) {
      expect(adapter.supports_effort(level)).toBe(true);
    }
  });

  test("models() returns pinned default gpt-5.1-codex-max + gpt-5.1-codex fallback; family 'codex'", async () => {
    const adapter = new CodexAdapter();
    const models = await adapter.models();
    expect(models.length).toBeGreaterThanOrEqual(2);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("gpt-5.1-codex-max");
    expect(ids).toContain("gpt-5.1-codex");
    // Pinned default must be first in the chain.
    expect(ids[0]).toBe("gpt-5.1-codex-max");
    for (const m of models) {
      expect(m.family).toBe("codex");
    }
  });
});
