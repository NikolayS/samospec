// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  contextJsonSchema,
  readContextJson,
  writeContextJson,
  type ContextJson,
  type RiskFlag,
} from "../../src/context/provenance.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-ctx-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const fresh = (): ContextJson => ({
  phase: "draft",
  files: [
    {
      path: "README.md",
      bytes: 123,
      tokens: 30,
      blob: "a".repeat(40),
      included: true,
      risk_flags: [],
    },
    {
      path: "src/huge.ts",
      bytes: 400_000,
      blob: "b".repeat(40),
      included: false,
      gist_id: ("b".repeat(40)) + ".md",
      risk_flags: ["large_file_truncated"],
    },
  ],
  risk_flags: ["large_file_truncated"],
  budget: {
    phase: "draft",
    tokens_used: 30,
    tokens_budget: 30_000,
  },
});

describe("context/provenance — schema (SPEC §7, §9)", () => {
  test("valid ContextJson passes schema.parse", () => {
    const r = contextJsonSchema.safeParse(fresh());
    expect(r.success).toBe(true);
  });

  test("unknown risk_flag value is rejected", () => {
    const bad = {
      ...fresh(),
      risk_flags: ["bogus"] as unknown as RiskFlag[],
    };
    const r = contextJsonSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  test("negative bytes are rejected", () => {
    const bad = fresh();
    // @ts-expect-error intentional mutation for negative test
    bad.files[0].bytes = -1;
    const r = contextJsonSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });
});

describe("context/provenance — read/write round-trip", () => {
  test("writeContextJson + readContextJson round-trips deep-equal", () => {
    const file = path.join(tmp, "context.json");
    const ctx = fresh();
    writeContextJson(file, ctx);
    const loaded = readContextJson(file);
    expect(loaded).toEqual(ctx);
  });

  test("writeContextJson rejects invalid input", () => {
    const file = path.join(tmp, "context.json");
    const bad = { ...fresh(), risk_flags: ["nope"] as unknown as RiskFlag[] };
    expect(() => writeContextJson(file, bad as unknown as ContextJson)).toThrow(
      /context\.json/i,
    );
  });

  test("readContextJson rejects malformed JSON", () => {
    const file = path.join(tmp, "context.json");
    writeFileSync(file, "not-json", "utf8");
    expect(() => readContextJson(file)).toThrow(/context\.json/i);
  });

  test("readContextJson rejects schema-invalid JSON", () => {
    const file = path.join(tmp, "context.json");
    writeFileSync(file, JSON.stringify({ phase: "draft" }), "utf8");
    expect(() => readContextJson(file)).toThrow(/context\.json/i);
  });
});
