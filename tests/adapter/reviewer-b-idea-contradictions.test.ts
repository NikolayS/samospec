// Copyright 2026 Nikolay Samokhvalov.

// RED tests for #85 Lever B: Reviewer B must receive the original idea
// string and flag contradiction findings when the spec reintroduces a
// class that the idea explicitly disclaimed.
//
// These tests drive ClaudeReviewerBAdapter through a fake-spawn harness
// and inspect (a) what the prompt builder emits when given an idea-aware
// CritiqueInput, and (b) that a synthetic Reviewer B response containing
// a contradiction finding passes schema validation end-to-end.

import { describe, expect, test } from "bun:test";

import {
  ClaudeReviewerBAdapter,
  buildCritiquePromptForReviewerB,
} from "../../src/adapter/claude-reviewer-b.ts";
import type { CritiqueInput } from "../../src/adapter/types.ts";
import type { SpawnCliInput, SpawnCliResult } from "../../src/adapter/spawn.ts";

// ---------- helpers ----------

function makeInstalledHost(): Record<string, string | undefined> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/tmp",
    ANTHROPIC_API_KEY: "sk-ant-test-fake-key",
  };
}

const OPTS = { effort: "max" as const, timeout: 120_000 };

function makeSpy(scripted: SpawnCliResult): {
  spawn: (i: SpawnCliInput) => Promise<SpawnCliResult>;
  calls: SpawnCliInput[];
} {
  const calls: SpawnCliInput[] = [];
  const spawn = (i: SpawnCliInput): Promise<SpawnCliResult> => {
    calls.push(i);
    return Promise.resolve(scripted);
  };
  return { spawn, calls };
}

// ---------- buildCritiquePromptForReviewerB — exported builder ----------

describe("buildCritiquePromptForReviewerB — idea-contradiction directive (#85)", () => {
  test("exported function exists", () => {
    expect(typeof buildCritiquePromptForReviewerB).toBe("function");
  });

  test("prompt includes the original idea string", () => {
    const idea = "NOT a CRUD todo app";
    const input: CritiqueInput = {
      spec: "# Spec\n\n§5: todo-list CRUD operations for baseline tracking.",
      guidelines: "be pedantic",
      opts: OPTS,
      idea,
    };
    const prompt = buildCritiquePromptForReviewerB(input);
    expect(prompt).toContain(idea);
  });

  test('prompt instructs reviewer B to flag "contradiction" for disclaimed classes', () => {
    const input: CritiqueInput = {
      spec: "# Spec",
      guidelines: "",
      opts: OPTS,
      idea: "NOT a todo-list app",
    };
    const prompt = buildCritiquePromptForReviewerB(input);
    // Must instruct to flag contradiction findings
    expect(prompt).toContain("contradiction");
  });

  test("prompt instructs to quote the disclaimer", () => {
    const input: CritiqueInput = {
      spec: "# Spec",
      guidelines: "",
      opts: OPTS,
      idea: "NOT a todo-list app",
    };
    const prompt = buildCritiquePromptForReviewerB(input);
    // Must tell reviewer B to quote the disclaimer text
    const lower = prompt.toLowerCase();
    const hasQuote =
      lower.includes("quote") ||
      lower.includes("disclaim") ||
      lower.includes("disclaimer");
    expect(hasQuote).toBe(true);
  });

  test("prompt still includes REVIEWER_B_PERSONA_PREFIX framing", () => {
    const input: CritiqueInput = {
      spec: "# Spec",
      guidelines: "",
      opts: OPTS,
      idea: "CLI that greps comments. NOT a todo-list app.",
    };
    const prompt = buildCritiquePromptForReviewerB(input);
    expect(prompt).toContain("ambiguity");
    expect(prompt).toContain("weak-testing");
  });

  test("when no idea provided, prompt still works and is a valid string", () => {
    const input: CritiqueInput = {
      spec: "# Spec",
      guidelines: "",
      opts: OPTS,
    };
    const prompt = buildCritiquePromptForReviewerB(input);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ---------- ClaudeReviewerBAdapter — idea threaded through critique() ----------

describe("ClaudeReviewerBAdapter — idea in critique() call (#85)", () => {
  test("critique() prompt carries the idea string when CritiqueInput.idea is set", async () => {
    const idea = "NOT a CRUD todo app";
    const contradictionFinding = {
      category: "contradiction" as const,
      text: 'Spec §5 describes "todo-list CRUD" — this contradicts the idea disclaimer: "NOT a CRUD todo app".',
      severity: "major" as const,
    };
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify({
        findings: [contradictionFinding],
        summary: "Reviewer B flagged an idea-contradiction in §5.",
        suggested_next_version: "0.1.1",
        usage: null,
        effort_used: "max",
      }),
      stderr: "",
    });

    const adapter = new ClaudeReviewerBAdapter({
      host: makeInstalledHost(),
      spawn: spy.spawn,
    });

    const input: CritiqueInput = {
      spec: "# todo-stream SPEC v0.1\n\n§5: todo-list CRUD operations baseline.",
      guidelines: "",
      opts: OPTS,
      idea,
    };

    const result = await adapter.critique(input);

    // Prompt must carry the idea string.
    const workCall = spy.calls.find((c) => c.stdin.length > 0);
    expect(workCall).toBeDefined();
    if (workCall === undefined) return;
    expect(workCall.stdin).toContain(idea);

    // Result must contain a contradiction finding.
    const contradictions = result.findings.filter(
      (f) => f.category === "contradiction",
    );
    expect(contradictions.length).toBeGreaterThan(0);
    const cf = contradictions[0];
    expect(cf).toBeDefined();
    if (cf === undefined) return;
    expect(cf.severity).toBe("major");
    // The finding text should quote the disclaimer
    expect(cf.text).toContain("NOT a CRUD todo app");
  });

  test("critique() without idea still works (backward compatible)", async () => {
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify({
        findings: [],
        summary: "looks good",
        suggested_next_version: "0.1.1",
        usage: null,
        effort_used: "max",
      }),
      stderr: "",
    });

    const adapter = new ClaudeReviewerBAdapter({
      host: makeInstalledHost(),
      spawn: spy.spawn,
    });

    const result = await adapter.critique({
      spec: "# SPEC\n\nContent.",
      guidelines: "",
      opts: OPTS,
    });

    expect(result.findings).toHaveLength(0);
    expect(result.summary).toBe("looks good");
  });
});

// ---------- fake integration: spec reintroduces disclaimed class ----------

describe("Reviewer B — fake integration: contradiction detection (#85)", () => {
  test("when spec mentions 'todo-list CRUD' and idea disclaimed it, reviewer B emits contradiction", async () => {
    // Spec §5 reintroduces "todo-list CRUD" — exactly what the idea disclaimed.
    const idea = "NOT a CRUD todo app";
    const specWithContradiction =
      "# todo-stream SPEC v0.1\n\n" +
      "## §4 Architecture\nBun/TypeScript CLI.\n\n" +
      "## §5 Implementation details\n" +
      "todo-list CRUD baseline add and .todo-stream-ignore for tracking.\n";

    // Fake Reviewer B emits a contradiction finding that quotes the disclaimer.
    const spy = makeSpy({
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify({
        findings: [
          {
            category: "contradiction",
            text:
              'Spec §5 reintroduces "todo-list CRUD" operations — this contradicts the ' +
              'idea disclaimer "NOT a CRUD todo app". Remove CRUD baseline tracking.',
            severity: "major",
          },
        ],
        summary:
          "Reviewer B found 1 idea-contradiction: spec §5 reintroduces disclaimed CRUD framing.",
        suggested_next_version: "0.1.1",
        usage: null,
        effort_used: "max",
      }),
      stderr: "",
    });

    const adapter = new ClaudeReviewerBAdapter({
      host: makeInstalledHost(),
      spawn: spy.spawn,
    });

    const result = await adapter.critique({
      spec: specWithContradiction,
      guidelines: "",
      opts: OPTS,
      idea,
    });

    // Must have at least one contradiction finding.
    const contradictions = result.findings.filter(
      (f) => f.category === "contradiction",
    );
    expect(contradictions.length).toBeGreaterThanOrEqual(1);

    // The contradiction finding must quote the disclaimer.
    const cf = contradictions[0];
    expect(cf).toBeDefined();
    if (cf === undefined) return;
    expect(cf.text).toContain("NOT a CRUD todo app");
    expect(cf.severity).toBe("major");

    // Prompt sent to the (fake) Reviewer B must include the idea string.
    const workCall = spy.calls.find((c) => c.stdin.length > 0);
    expect(workCall).toBeDefined();
    if (workCall === undefined) return;
    expect(workCall.stdin).toContain(idea);
  });
});
