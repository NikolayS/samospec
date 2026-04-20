// Copyright 2026 Nikolay Samokhvalov.

// Tests for the Claude adapter (SPEC §7, §11, §13 test 4).

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAdapter } from "../../src/adapter/claude.ts";

const TMP_DIRS: string[] = [];

function makeEmptyPathDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "samospec-empty-path-"));
  TMP_DIRS.push(dir);
  return dir;
}

function makeFakeBinaryDir(
  name: string,
  script: string,
): { dir: string; binary: string } {
  const dir = mkdtempSync(join(tmpdir(), "samospec-fake-bin-"));
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

describe("ClaudeAdapter — lifecycle (SPEC §7, §11)", () => {
  test("vendor is 'claude'", () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.vendor).toBe("claude");
  });

  test("detect() returns { installed: false } when PATH has no claude binary", async () => {
    const emptyDir = makeEmptyPathDir();
    const adapter = new ClaudeAdapter({
      host: { PATH: emptyDir, HOME: "/tmp" },
    });
    const result = await adapter.detect();
    expect(result.installed).toBe(false);
  });

  test("detect() returns { installed: true, version, path } when claude binary exists", async () => {
    const { dir, binary } = makeFakeBinaryDir(
      "claude",
      'echo "2.1.114 (Claude Code)"',
    );
    const adapter = new ClaudeAdapter({
      host: { PATH: dir, HOME: "/tmp" },
    });
    const result = await adapter.detect();
    expect(result.installed).toBe(true);
    if (result.installed) {
      expect(result.version.length).toBeGreaterThan(0);
      expect(result.path).toBe(binary);
    }
  });

  test("supports_structured_output() returns true", () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.supports_structured_output()).toBe(true);
  });

  test("supports_effort() returns true for every effort level", () => {
    const adapter = new ClaudeAdapter();
    for (const level of ["max", "high", "medium", "low", "off"] as const) {
      expect(adapter.supports_effort(level)).toBe(true);
    }
  });

  test("models() returns pinned default model with family 'claude'", async () => {
    const adapter = new ClaudeAdapter();
    const models = await adapter.models();
    expect(models.length).toBeGreaterThan(0);
    const ids = models.map((m) => m.id);
    expect(ids).toContain("claude-opus-4-7");
    for (const m of models) {
      expect(m.family).toBe("claude");
    }
  });
});
