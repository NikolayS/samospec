// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §5 Phase 7 + §9 — blueprint promotion.
 *
 *   - Copies `.samospec/spec/<slug>/SPEC.md` → `blueprints/<slug>/SPEC.md`.
 *   - Creates `blueprints/<slug>/` when missing.
 *   - Overwrites an existing promoted blueprint on republish (though
 *     runPublish itself blocks republish; the copy primitive remains
 *     idempotent so a manual re-run is not a footgun).
 *   - Returns the absolute destination path so callers can stage it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { promoteSpecToBlueprint } from "../../src/publish/blueprints.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-blueprints-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("promoteSpecToBlueprint", () => {
  test("copies SPEC.md, creating blueprints/<slug>/ when missing", () => {
    const slugDir = path.join(tmp, ".samospec", "spec", "refunds");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(
      path.join(slugDir, "SPEC.md"),
      "# SPEC\n\nv0.2 body\n",
      "utf8",
    );
    const dest = promoteSpecToBlueprint({
      cwd: tmp,
      slug: "refunds",
    });
    expect(dest).toBe(path.join(tmp, "blueprints", "refunds", "SPEC.md"));
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe("# SPEC\n\nv0.2 body\n");
  });

  test("overwrites an existing blueprint file idempotently", () => {
    const slugDir = path.join(tmp, ".samospec", "spec", "refunds");
    mkdirSync(slugDir, { recursive: true });
    writeFileSync(path.join(slugDir, "SPEC.md"), "NEW\n", "utf8");

    const blueprintDir = path.join(tmp, "blueprints", "refunds");
    mkdirSync(blueprintDir, { recursive: true });
    writeFileSync(path.join(blueprintDir, "SPEC.md"), "OLD\n", "utf8");

    const dest = promoteSpecToBlueprint({ cwd: tmp, slug: "refunds" });
    expect(readFileSync(dest, "utf8")).toBe("NEW\n");
  });

  test("throws when the source SPEC.md is missing", () => {
    mkdirSync(path.join(tmp, ".samospec", "spec", "refunds"), {
      recursive: true,
    });
    expect(() => promoteSpecToBlueprint({ cwd: tmp, slug: "refunds" })).toThrow(
      /SPEC\.md/,
    );
  });
});
