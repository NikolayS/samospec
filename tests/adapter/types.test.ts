// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import {
  AskOutputSchema,
  AuthStatusSchema,
  CritiqueOutputSchema,
  DetectResultSchema,
  EffortLevelSchema,
  ReviseOutputSchema,
  WorkOptsSchema,
} from "../../src/adapter/types.ts";

describe("adapter zod schemas (SPEC §7)", () => {
  describe("EffortLevelSchema", () => {
    test("accepts known levels", () => {
      for (const level of ["max", "high", "medium", "low", "off"]) {
        expect(() => EffortLevelSchema.parse(level)).not.toThrow();
      }
    });

    test("rejects unknown levels", () => {
      expect(() => EffortLevelSchema.parse("ludicrous")).toThrow();
    });
  });

  describe("WorkOptsSchema", () => {
    test("accepts a well-formed opts object", () => {
      const opts = { effort: "max", timeout: 120_000 };
      expect(WorkOptsSchema.parse(opts)).toEqual(opts);
    });

    test("rejects negative timeouts", () => {
      expect(() =>
        WorkOptsSchema.parse({ effort: "max", timeout: -1 }),
      ).toThrow();
    });

    test("rejects non-integer timeouts", () => {
      expect(() =>
        WorkOptsSchema.parse({ effort: "max", timeout: 1.5 }),
      ).toThrow();
    });
  });

  describe("DetectResultSchema", () => {
    test("accepts installed=true with version+path", () => {
      const r = { installed: true, version: "1.2.3", path: "/usr/bin/claude" };
      expect(DetectResultSchema.parse(r)).toEqual(r);
    });

    test("accepts installed=false", () => {
      const r = { installed: false };
      expect(DetectResultSchema.parse(r)).toEqual(r);
    });
  });

  describe("AuthStatusSchema", () => {
    test("accepts a plain API-key authenticated adapter", () => {
      const r = { authenticated: true, account: "nik@example.com" };
      expect(AuthStatusSchema.parse(r)).toEqual(r);
    });

    test("accepts subscription-auth with subscription_auth=true", () => {
      const r = {
        authenticated: true,
        account: "subscription",
        subscription_auth: true,
      };
      expect(AuthStatusSchema.parse(r)).toEqual(r);
    });

    test("accepts not-authenticated", () => {
      const r = { authenticated: false };
      expect(AuthStatusSchema.parse(r)).toEqual(r);
    });
  });

  describe("AskOutputSchema", () => {
    test("accepts usage:null (subscription auth)", () => {
      const r = {
        answer: "hi",
        usage: null,
        effort_used: "max",
      };
      expect(AskOutputSchema.parse(r)).toEqual(r);
    });

    test("accepts usage with token counts", () => {
      const r = {
        answer: "hi",
        usage: { input_tokens: 10, output_tokens: 5 },
        effort_used: "high",
      };
      expect(AskOutputSchema.parse(r)).toEqual(r);
    });
  });

  describe("CritiqueOutputSchema", () => {
    test("accepts a findings array with required categories", () => {
      const r = {
        findings: [
          {
            category: "ambiguity",
            text: "'significant' is ambiguous",
            severity: "minor",
          },
        ],
        summary: "one nit",
        suggested_next_version: "0.1.1",
        usage: null,
        effort_used: "max",
      };
      expect(CritiqueOutputSchema.parse(r)).toEqual(r);
    });

    test("rejects a finding with an unknown category", () => {
      const r = {
        findings: [
          { category: "vibe-check", text: "idk", severity: "minor" },
        ],
        summary: "",
        suggested_next_version: "0.1.1",
        usage: null,
        effort_used: "max",
      };
      expect(() => CritiqueOutputSchema.parse(r)).toThrow();
    });
  });

  describe("ReviseOutputSchema (lead-ready protocol)", () => {
    test("ready and rationale are inline", () => {
      const r = {
        spec: "# SPEC\n\n...",
        ready: true,
        rationale: "converged",
        usage: null,
        effort_used: "max",
      };
      expect(ReviseOutputSchema.parse(r)).toEqual(r);
    });

    test("rejects missing ready field", () => {
      const r = {
        spec: "# SPEC\n\n...",
        rationale: "converged",
        usage: null,
        effort_used: "max",
      };
      expect(() => ReviseOutputSchema.parse(r)).toThrow();
    });
  });
});
