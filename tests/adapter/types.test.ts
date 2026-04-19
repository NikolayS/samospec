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
      const opts: unknown = { effort: "max", timeout: 120_000 };
      const parsed = WorkOptsSchema.parse(opts);
      expect(parsed.effort).toBe("max");
      expect(parsed.timeout).toBe(120_000);
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
      const r: unknown = {
        installed: true,
        version: "1.2.3",
        path: "/usr/bin/claude",
      };
      const parsed = DetectResultSchema.parse(r);
      expect(parsed.installed).toBe(true);
      if (parsed.installed) {
        expect(parsed.version).toBe("1.2.3");
        expect(parsed.path).toBe("/usr/bin/claude");
      }
    });

    test("accepts installed=false", () => {
      const r: unknown = { installed: false };
      const parsed = DetectResultSchema.parse(r);
      expect(parsed.installed).toBe(false);
    });
  });

  describe("AuthStatusSchema", () => {
    test("accepts a plain API-key authenticated adapter", () => {
      const r: unknown = { authenticated: true, account: "nik@example.com" };
      const parsed = AuthStatusSchema.parse(r);
      expect(parsed.authenticated).toBe(true);
      expect(parsed.account).toBe("nik@example.com");
      expect(parsed.subscription_auth).toBeUndefined();
    });

    test("accepts subscription-auth with subscription_auth=true", () => {
      const r: unknown = {
        authenticated: true,
        account: "subscription",
        subscription_auth: true,
      };
      const parsed = AuthStatusSchema.parse(r);
      expect(parsed.subscription_auth).toBe(true);
    });

    test("accepts not-authenticated", () => {
      const r: unknown = { authenticated: false };
      const parsed = AuthStatusSchema.parse(r);
      expect(parsed.authenticated).toBe(false);
    });
  });

  describe("AskOutputSchema", () => {
    test("accepts usage:null (subscription auth)", () => {
      const r: unknown = {
        answer: "hi",
        usage: null,
        effort_used: "max",
      };
      const parsed = AskOutputSchema.parse(r);
      expect(parsed.usage).toBeNull();
      expect(parsed.effort_used).toBe("max");
    });

    test("accepts usage with token counts", () => {
      const r: unknown = {
        answer: "hi",
        usage: { input_tokens: 10, output_tokens: 5 },
        effort_used: "high",
      };
      const parsed = AskOutputSchema.parse(r);
      expect(parsed.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    });
  });

  describe("CritiqueOutputSchema", () => {
    test("accepts a findings array with required categories", () => {
      const r: unknown = {
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
      const parsed = CritiqueOutputSchema.parse(r);
      expect(parsed.findings).toHaveLength(1);
      expect(parsed.findings[0]?.category).toBe("ambiguity");
    });

    test("rejects a finding with an unknown category", () => {
      const r = {
        findings: [{ category: "vibe-check", text: "idk", severity: "minor" }],
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
      const r: unknown = {
        spec: "# SPEC\n\n...",
        ready: true,
        rationale: "converged",
        usage: null,
        effort_used: "max",
      };
      const parsed = ReviseOutputSchema.parse(r);
      expect(parsed.ready).toBe(true);
      expect(parsed.rationale).toBe("converged");
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
