// Copyright 2026 Nikolay Samokhvalov.

// RED tests for #59: ReviseOutput schema accepts an optional decisions
// array with verdict/rationale, and extra fields don't break existing callers.

import { test, expect, describe } from "bun:test";
import { ReviseOutputSchema } from "../../src/adapter/schemas.ts";

describe("ReviseOutputSchema — decisions array (optional)", () => {
  const baseValid = {
    spec: "# MySpec\nContent here.",
    ready: false,
    rationale: "One more round needed.",
    usage: null,
    effort_used: "max",
  };

  test("parses without decisions field (backward compat)", () => {
    const result = ReviseOutputSchema.safeParse(baseValid);
    expect(result.success).toBe(true);
  });

  test("parses with empty decisions array", () => {
    const result = ReviseOutputSchema.safeParse({
      ...baseValid,
      decisions: [],
    });
    expect(result.success).toBe(true);
  });

  test("parses with one accepted decision", () => {
    const result = ReviseOutputSchema.safeParse({
      ...baseValid,
      decisions: [
        {
          category: "missing-requirement",
          verdict: "accepted",
          rationale: "Added rate-limit section to the spec.",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const d = result.data.decisions?.[0];
      expect(d?.verdict).toBe("accepted");
      expect(d?.rationale).toBe("Added rate-limit section to the spec.");
    }
  });

  test("parses with rejected decision", () => {
    const result = ReviseOutputSchema.safeParse({
      ...baseValid,
      decisions: [
        {
          category: "unnecessary-scope",
          verdict: "rejected",
          rationale: "The proposed section is out of v1 scope.",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("parses with deferred decision", () => {
    const result = ReviseOutputSchema.safeParse({
      ...baseValid,
      decisions: [
        {
          category: "weak-testing",
          verdict: "deferred",
          rationale: "Will address in sprint 2 testing phase.",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("parses with optional finding_id present", () => {
    const result = ReviseOutputSchema.safeParse({
      ...baseValid,
      decisions: [
        {
          finding_id: "codex#1",
          category: "missing-requirement",
          verdict: "accepted",
          rationale: "Applied the reviewer's suggestion.",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.decisions?.[0]?.finding_id).toBe("codex#1");
    }
  });

  test("rejects invalid verdict value", () => {
    const result = ReviseOutputSchema.safeParse({
      ...baseValid,
      decisions: [
        {
          category: "ambiguity",
          verdict: "maybe", // invalid
          rationale: "Some reason.",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing rationale", () => {
    const result = ReviseOutputSchema.safeParse({
      ...baseValid,
      decisions: [
        {
          category: "ambiguity",
          verdict: "accepted",
          // rationale missing
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing category", () => {
    const result = ReviseOutputSchema.safeParse({
      ...baseValid,
      decisions: [
        {
          verdict: "accepted",
          rationale: "Some reason.",
          // category missing
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("multiple decisions in one output", () => {
    const result = ReviseOutputSchema.safeParse({
      ...baseValid,
      decisions: [
        {
          finding_id: "codex#1",
          category: "missing-requirement",
          verdict: "accepted",
          rationale: "Applied.",
        },
        {
          finding_id: "claude#1",
          category: "weak-testing",
          verdict: "rejected",
          rationale: "Already covered in §13.",
        },
        {
          finding_id: "claude#2",
          category: "ambiguity",
          verdict: "deferred",
          rationale: "Punted to v1.1.",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.decisions?.length).toBe(3);
    }
  });

  test("existing callers work without decisions field (type narrowing)", () => {
    // Simulate an existing caller that only reads spec/ready/rationale
    const result = ReviseOutputSchema.safeParse(baseValid);
    expect(result.success).toBe(true);
    if (result.success) {
      // decisions should be absent or undefined
      expect(result.data.decisions === undefined || result.data.decisions === null).toBe(true);
    }
  });
});
