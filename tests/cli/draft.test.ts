// Copyright 2026 Nikolay Samokhvalov.

// SPEC §5 Phase 5 + §7 — `authorDraft()` unit contract.
// Red-first:
//   1. Happy path: ReviseOutput forwarded as DraftResult.
//   2. effort/timeout defaults: "max" / 600_000 ms.
//   3. Scaffold contains persona, idea, each question + answer, and
//      every context chunk.
//   4. Adapter rejection with "refus" msg -> DraftTerminalError.refusal.
//   5. Adapter rejection with "schema" msg -> schema_fail.
//   6. Empty spec body after zod-skip -> schema_fail (defensive guard).
//   7. formatLeadTerminalMessage produces SPEC §7-aligned copy.

import { describe, expect, test } from "bun:test";

import type {
  Adapter,
  ReviseInput,
  ReviseOutput,
} from "../../src/adapter/types.ts";
import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type { InterviewResult } from "../../src/cli/interview.ts";
import {
  DRAFT_DEFAULT_EFFORT,
  DRAFT_REVISE_TIMEOUT_MS,
  authorDraft,
  buildDraftScaffold,
  DraftTerminalError,
  formatLeadTerminalMessage,
  type DraftInput,
} from "../../src/cli/draft.ts";

function interview(slug: string, persona: string): InterviewResult {
  return {
    slug,
    persona,
    generated_at: "2026-04-19T10:00:00Z",
    questions: [
      {
        id: "q1",
        text: "framework?",
        options: ["bun", "node", "decide for me"],
      },
      {
        id: "q2",
        text: "auth?",
        options: ["magic-link", "oauth", "decide for me"],
      },
    ],
    answers: [
      { id: "q1", choice: "bun" },
      { id: "q2", choice: "custom", custom: "passkey" },
    ],
  };
}

function baseInput(overrides: Partial<DraftInput> = {}): DraftInput {
  return {
    slug: "refunds",
    idea: "payment refunds for marketplace X",
    persona: 'Veteran "payments engineer" expert',
    interview: interview("refunds", 'Veteran "payments engineer" expert'),
    contextChunks: [],
    explain: false,
    ...overrides,
  };
}

function reviseOut(overrides: Partial<ReviseOutput> = {}): ReviseOutput {
  return {
    spec:
      "# refunds spec\n\n" +
      "## Goal\n\nLet marketplace-X sellers issue partial refunds.\n\n" +
      "## Scope\n\n- API\n- UI\n",
    ready: false,
    rationale: "v0.1 draft",
    usage: null,
    effort_used: "max",
    ...overrides,
  };
}

describe("authorDraft — happy path", () => {
  test("returns the ReviseOutput as a DraftResult", async () => {
    const adapter = createFakeAdapter({ revise: reviseOut() });
    const res = await authorDraft(baseInput(), adapter);
    expect(res.spec).toContain("# refunds spec");
    expect(res.ready).toBe(false);
    expect(res.rationale).toBe("v0.1 draft");
    expect(res.effort_used).toBe("max");
  });

  test("defaults to effort=max + timeout=600_000 ms (SPEC §7)", async () => {
    let captured: ReviseInput | null = null;
    const base = createFakeAdapter({ revise: reviseOut() });
    const adapter: Adapter = {
      ...base,
      revise: (input: ReviseInput): Promise<ReviseOutput> => {
        captured = input;
        return Promise.resolve(reviseOut());
      },
    };
    await authorDraft(baseInput(), adapter);
    expect(captured).not.toBeNull();
    expect(captured!.opts.effort).toBe(DRAFT_DEFAULT_EFFORT);
    expect(captured!.opts.effort).toBe("max");
    expect(captured!.opts.timeout).toBe(DRAFT_REVISE_TIMEOUT_MS);
    expect(captured!.opts.timeout).toBe(600_000);
    // First draft has no prior reviews / decisions.
    expect(captured!.reviews).toEqual([]);
    expect(captured!.decisions_history).toEqual([]);
  });
});

describe("buildDraftScaffold", () => {
  test("includes persona, idea, and each Q/A", () => {
    const scaffold = buildDraftScaffold(baseInput());
    expect(scaffold).toContain('Veteran "payments engineer" expert');
    expect(scaffold).toContain("payment refunds for marketplace X");
    expect(scaffold).toContain("q1");
    expect(scaffold).toContain("framework?");
    expect(scaffold).toContain("answer: bun");
    expect(scaffold).toContain("answer: custom: passkey");
  });

  test("carries plain-English reminder when explain=true", () => {
    const scaffold = buildDraftScaffold(baseInput({ explain: true }));
    expect(scaffold.toLowerCase()).toContain("plain english");
  });

  test("embeds context chunks verbatim (envelope wrapping preserved)", () => {
    const chunk =
      '<repo_content_abc12345 trusted="false" path="README.md" sha="abc12345">\n' +
      "# Project\n\nStuff\n" +
      "</repo_content_abc12345>\n";
    const scaffold = buildDraftScaffold(baseInput({ contextChunks: [chunk] }));
    expect(scaffold).toContain('<repo_content_abc12345 trusted="false"');
    expect(scaffold).toContain("</repo_content_abc12345>");
  });
});

describe("authorDraft — lead_terminal classification", () => {
  test("refusal message -> sub_reason=refusal", async () => {
    const base = createFakeAdapter({ revise: reviseOut() });
    const adapter: Adapter = {
      ...base,
      revise: (): Promise<ReviseOutput> =>
        Promise.reject(new Error("model refused the prompt")),
    };
    try {
      await authorDraft(baseInput(), adapter);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DraftTerminalError);
      expect((err as DraftTerminalError).sub_reason).toBe("refusal");
    }
  });

  test("schema violation message -> sub_reason=schema_fail", async () => {
    const base = createFakeAdapter({ revise: reviseOut() });
    const adapter: Adapter = {
      ...base,
      revise: (): Promise<ReviseOutput> =>
        Promise.reject(new Error("schema_violation: bad JSON")),
    };
    try {
      await authorDraft(baseInput(), adapter);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as DraftTerminalError).sub_reason).toBe("schema_fail");
    }
  });

  test("budget-cap message -> sub_reason=budget", async () => {
    const base = createFakeAdapter({ revise: reviseOut() });
    const adapter: Adapter = {
      ...base,
      revise: (): Promise<ReviseOutput> =>
        Promise.reject(new Error("budget cap exceeded")),
    };
    try {
      await authorDraft(baseInput(), adapter);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as DraftTerminalError).sub_reason).toBe("budget");
    }
  });

  test("unclassified error -> sub_reason=adapter_error", async () => {
    const base = createFakeAdapter({ revise: reviseOut() });
    const adapter: Adapter = {
      ...base,
      revise: (): Promise<ReviseOutput> =>
        Promise.reject(new Error("unexpected EOF from subprocess")),
    };
    try {
      await authorDraft(baseInput(), adapter);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as DraftTerminalError).sub_reason).toBe("adapter_error");
    }
  });
});

describe("formatLeadTerminalMessage — SPEC §7 copy", () => {
  test("refusal copy", () => {
    const msg = formatLeadTerminalMessage("refunds", "refusal", "demo");
    expect(msg.toLowerCase()).toContain("refused");
    expect(msg).toContain(".samospec/spec/refunds/SPEC.md");
  });

  test("schema_fail copy", () => {
    const msg = formatLeadTerminalMessage("refunds", "schema_fail", "");
    expect(msg.toLowerCase()).toContain("invalid structured output");
  });

  test("invalid_input copy", () => {
    const msg = formatLeadTerminalMessage("refunds", "invalid_input", "");
    expect(msg.toLowerCase()).toContain("too large or malformed");
  });

  test("budget copy mentions --effort or budget.*", () => {
    const msg = formatLeadTerminalMessage("refunds", "budget", "");
    expect(msg).toMatch(/--effort|budget\./);
  });

  test("wall_clock copy mentions resume", () => {
    const msg = formatLeadTerminalMessage("refunds", "wall_clock", "");
    expect(msg.toLowerCase()).toContain("wall-clock");
    expect(msg.toLowerCase()).toContain("resume");
  });
});
