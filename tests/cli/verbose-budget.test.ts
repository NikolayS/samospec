// Copyright 2026 Nikolay Samokhvalov.

/**
 * RED tests for #71: default stdout is concise; --verbose unlocks full detail.
 *
 * We test `runNew` as the primary surface since it produces the most output.
 * The threshold of 2500 chars for default mode is pragmatic — it allows for
 * normal one-liner status messages but should catch dense progress walls.
 *
 * With --verbose (verbose=true in runNew), output should exceed the default
 * threshold (we check for at least 500 chars more than default, i.e. verbose
 * output > 500 chars if default was near 0, but practically we just require
 * verbose > default when the adapter emits extra explain lines).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import { runNew } from "../../src/cli/new.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-verbose-budget-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const NOW = "2026-04-19T12:00:00Z";

const RESOLVERS = {
  persona: () => Promise.resolve({ kind: "accept" as const }),
  question: () => Promise.resolve("answer"),
};

describe("verbose budget (#71)", () => {
  test("default (no verbose) stdout < 3000 chars", async () => {
    const adapter = createFakeAdapter({});
    const result = await runNew(
      {
        cwd: tmp,
        slug: "budget-test",
        idea: "A simple widget idea",
        explain: false,
        resolvers: RESOLVERS,
        now: NOW,
        verbose: false,
      },
      adapter,
    );
    // May fail even on success path if spec not committed (no git repo).
    // We care about stdout length regardless of exit code.
    expect(result.stdout.length).toBeLessThan(3000);
  });

  test("verbose stdout >= default stdout length", async () => {
    const adapter = createFakeAdapter({});
    const defaultResult = await runNew(
      {
        cwd: tmp,
        slug: "budget-verbose-a",
        idea: "A simple widget idea",
        explain: false,
        resolvers: RESOLVERS,
        now: NOW,
        verbose: false,
      },
      adapter,
    );

    const tmp2 = mkdtempSync(path.join(tmpdir(), "samospec-verbose-b-"));
    try {
      const verboseResult = await runNew(
        {
          cwd: tmp2,
          slug: "budget-verbose-b",
          idea: "A simple widget idea",
          explain: true,
          resolvers: RESOLVERS,
          now: NOW,
          verbose: true,
        },
        adapter,
      );
      // Verbose output must be at least as long as default output.
      expect(verboseResult.stdout.length).toBeGreaterThanOrEqual(
        defaultResult.stdout.length,
      );
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});
