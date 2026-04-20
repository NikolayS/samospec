// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §14 — publish-lint seam (stub).
 *
 * Issue #33 will fill this in. For Issue #32 the seam exists and returns
 * an empty report so `samospec publish` does not regress on the basis of
 * an unimplemented downstream module.
 */

import { describe, expect, test } from "bun:test";

import { publishLintStub } from "../../src/publish/lint-stub.ts";

describe("publishLintStub", () => {
  test("returns empty hard + soft warnings", () => {
    const report = publishLintStub({
      specBody: "# SPEC\n\nbody\n",
      repoPath: "/tmp/noop",
      slug: "demo",
    });
    expect(report.hardWarnings).toEqual([]);
    expect(report.softWarnings).toEqual([]);
  });

  test("is deterministic across calls", () => {
    const a = publishLintStub({
      specBody: "# SPEC\n",
      repoPath: "/tmp/noop",
      slug: "demo",
    });
    const b = publishLintStub({
      specBody: "# SPEC\n",
      repoPath: "/tmp/noop",
      slug: "demo",
    });
    expect(a).toEqual(b);
  });
});
