// Copyright 2026 Nikolay Samokhvalov.

// Barrel sanity: src/adapter/schemas.ts re-exports the authoritative
// review-taxonomy + revise schemas from ./types.ts. This keeps a
// stable import path for downstream modules (loop, reviewer, render)
// without entangling them with adapter internals.

import { describe, expect, test } from "bun:test";

import * as types from "../../src/adapter/types.ts";
import * as schemas from "../../src/adapter/schemas.ts";

describe("src/adapter/schemas.ts barrel (SPEC §7)", () => {
  test("re-exports review-taxonomy schemas identical to types.ts", () => {
    expect(schemas.FindingCategorySchema).toBe(types.FindingCategorySchema);
    expect(schemas.FindingSeveritySchema).toBe(types.FindingSeveritySchema);
    expect(schemas.FindingSchema).toBe(types.FindingSchema);
    expect(schemas.CritiqueInputSchema).toBe(types.CritiqueInputSchema);
    expect(schemas.CritiqueOutputSchema).toBe(types.CritiqueOutputSchema);
  });

  test("re-exports revise schemas identical to types.ts", () => {
    expect(schemas.DecisionSchema).toBe(types.DecisionSchema);
    expect(schemas.ReviseInputSchema).toBe(types.ReviseInputSchema);
    expect(schemas.ReviseOutputSchema).toBe(types.ReviseOutputSchema);
  });
});
