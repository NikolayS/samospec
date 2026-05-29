// Copyright 2026 Nikolay Samokhvalov.

// Tests for `samospec new` Phase 4 — 5-question strategic interview
// (SPEC §5 Phase 4).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type {
  Adapter,
  AskInput,
  AskOutput,
  EffortLevel,
} from "../../src/adapter/types.ts";
import {
  INTERVIEW_MAX_QUESTIONS,
  INTERVIEW_ESCAPE_HATCHES,
  InterviewFileSchema,
  ideaHasOpenLanguage,
  readInterview,
  runInterview,
  writeInterview,
} from "../../src/cli/interview.ts";

function askOutputWithAnswer(answer: string): AskOutput {
  return { answer, usage: null, effort_used: "max" };
}

interface ScriptedAskAdapter extends Adapter {
  readonly asks: readonly AskInput[];
}

function makeScriptedAskAdapter(
  answers: readonly string[],
): ScriptedAskAdapter {
  const base = createFakeAdapter();
  const asks: AskInput[] = [];
  let call = 0;
  const scripted: Adapter = {
    ...base,
    ask: (input: AskInput): Promise<AskOutput> => {
      asks.push(input);
      const answer = answers[call] ?? answers[answers.length - 1] ?? "";
      call += 1;
      return Promise.resolve(askOutputWithAnswer(answer));
    },
  };
  const result = Object.assign(scripted, { asks }) as ScriptedAskAdapter;
  return result;
}

// A deterministic autoresponder: resolves every question to the first
// listed option (or "decide for me" if none provided). Captures the
// questions for assertions.
function autoAnswerFirst(): {
  answer: (q: {
    readonly id: string;
    readonly text: string;
    readonly options: readonly string[];
  }) => Promise<{ readonly choice: string; readonly custom?: string }>;
  saw: { id: string; text: string }[];
} {
  const saw: { id: string; text: string }[] = [];
  return {
    saw,
    answer: async (q) => {
      saw.push({ id: q.id, text: q.text });
      const first = q.options[0] ?? "decide for me";
      await Promise.resolve();
      return { choice: first };
    },
  };
}

function makeQuestionsJson(
  items: readonly { readonly id: string; readonly text: string }[],
): string {
  return JSON.stringify({
    questions: items.map((it) => ({
      id: it.id,
      text: it.text,
      options: [`option A for ${it.id}`, `option B for ${it.id}`],
    })),
  });
}

// ---------- escape hatches / constants ----------

describe("interview constants (SPEC §5 Phase 4)", () => {
  test("INTERVIEW_MAX_QUESTIONS is 5", () => {
    expect(INTERVIEW_MAX_QUESTIONS).toBe(5);
  });

  test("INTERVIEW_ESCAPE_HATCHES contains exactly the three universal options", () => {
    expect(INTERVIEW_ESCAPE_HATCHES).toEqual([
      "decide for me",
      "not sure — defer",
      "custom",
    ]);
  });
});

// ---------- hard cap 5 ----------

describe("runInterview — hard cap at 5 (SPEC §5 Phase 4)", () => {
  test("lead returns 7 questions -> only first 5 are asked, extras dropped", async () => {
    const sevenQs = Array.from({ length: 7 }, (_, i) => ({
      id: `q${String(i + 1)}`,
      text: `question ${String(i + 1)}?`,
    }));
    const adapter = makeScriptedAskAdapter([makeQuestionsJson(sevenQs)]);
    const auto = autoAnswerFirst();

    const answers = await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        onQuestion: auto.answer,
      },
      adapter,
    );

    expect(auto.saw.length).toBe(5);
    expect(answers.answers.length).toBe(5);
    expect(auto.saw.map((s) => s.id)).toEqual(["q1", "q2", "q3", "q4", "q5"]);
  });

  test("lead returns 3 questions -> proceeds with 3", async () => {
    const threeQs = Array.from({ length: 3 }, (_, i) => ({
      id: `q${String(i + 1)}`,
      text: `question ${String(i + 1)}?`,
    }));
    const adapter = makeScriptedAskAdapter([makeQuestionsJson(threeQs)]);
    const auto = autoAnswerFirst();
    const answers = await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        onQuestion: auto.answer,
      },
      adapter,
    );
    expect(answers.answers.length).toBe(3);
  });

  test("lead returns 0 questions -> empty interview result", async () => {
    const adapter = makeScriptedAskAdapter([makeQuestionsJson([])]);
    const auto = autoAnswerFirst();
    const answers = await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        onQuestion: auto.answer,
      },
      adapter,
    );
    expect(answers.answers.length).toBe(0);
  });
});

// ---------- escape hatches ----------

describe("runInterview — escape hatches always present (SPEC §5 Phase 4)", () => {
  test("each question's options includes `decide for me`, `not sure — defer`, `custom`", async () => {
    const qs = Array.from({ length: 3 }, (_, i) => ({
      id: `q${String(i + 1)}`,
      text: `question ${String(i + 1)}?`,
    }));
    const adapter = makeScriptedAskAdapter([makeQuestionsJson(qs)]);
    const seenOptions: readonly string[][] = [];
    await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        onQuestion: (q) => {
          (seenOptions as string[][]).push([...q.options]);
          return Promise.resolve({ choice: "decide for me" });
        },
      },
      adapter,
    );
    for (const opts of seenOptions) {
      expect(opts).toContain("decide for me");
      expect(opts).toContain("not sure — defer");
      expect(opts).toContain("custom");
    }
  });

  test("choice = custom + custom text is captured into the answer record", async () => {
    const qs = [{ id: "q1", text: "what framework?" }];
    const adapter = makeScriptedAskAdapter([makeQuestionsJson(qs)]);
    const out = await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        onQuestion: (_q) =>
          Promise.resolve({ choice: "custom", custom: "Bun + TypeScript" }),
      },
      adapter,
    );
    expect(out.answers.length).toBe(1);
    const a = out.answers[0];
    expect(a.choice).toBe("custom");
    expect(a.custom).toBe("Bun + TypeScript");
  });

  test("choice = decide for me is persisted verbatim", async () => {
    const qs = [{ id: "q1", text: "which database?" }];
    const adapter = makeScriptedAskAdapter([makeQuestionsJson(qs)]);
    const out = await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        onQuestion: (_q) => Promise.resolve({ choice: "decide for me" }),
      },
      adapter,
    );
    expect(out.answers.length).toBe(1);
    expect(out.answers[0].choice).toBe("decide for me");
  });

  test("choice = not sure — defer is persisted verbatim", async () => {
    const qs = [{ id: "q1", text: "target platform?" }];
    const adapter = makeScriptedAskAdapter([makeQuestionsJson(qs)]);
    const out = await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        onQuestion: (_q) => Promise.resolve({ choice: "not sure — defer" }),
      },
      adapter,
    );
    expect(out.answers[0].choice).toBe("not sure — defer");
  });
});

// ---------- ideaHasOpenLanguage ----------

describe("ideaHasOpenLanguage — language-open detection (#129)", () => {
  test("explicit 'language choice open' -> true", () => {
    expect(ideaHasOpenLanguage("Build a TUI. Language choice open.")).toBe(
      true,
    );
  });

  test("'language open' -> true", () => {
    expect(ideaHasOpenLanguage("some project, language open")).toBe(true);
  });

  test("'language flexible' -> true", () => {
    expect(ideaHasOpenLanguage("REST API. Language flexible.")).toBe(true);
  });

  test("'language any' -> true", () => {
    expect(ideaHasOpenLanguage("CLI tool. Language any.")).toBe(true);
  });

  test("no language keyword at all -> true (open by default)", () => {
    expect(ideaHasOpenLanguage("Build a REST API service.")).toBe(true);
  });

  test("'in Rust' -> false (language specified)", () => {
    expect(ideaHasOpenLanguage("Build a CLI in Rust.")).toBe(false);
  });

  test("'using Python' -> false", () => {
    expect(ideaHasOpenLanguage("data pipeline using Python")).toBe(false);
  });

  test("'TypeScript backend' -> false", () => {
    expect(ideaHasOpenLanguage("TypeScript backend with Express")).toBe(false);
  });

  test("'Go service' -> false", () => {
    expect(ideaHasOpenLanguage("high-throughput Go service")).toBe(false);
  });
});

// ---------- persona + explain wiring ----------

describe("runInterview — persona + explain wiring (SPEC §7)", () => {
  test("system prompt contains the persona string", async () => {
    const qs = [{ id: "q1", text: "something?" }];
    const adapter = makeScriptedAskAdapter([makeQuestionsJson(qs)]);
    await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI software engineer" expert',
        explain: false,
        subscriptionAuth: false,
        onQuestion: (_q) => Promise.resolve({ choice: "decide for me" }),
      },
      adapter,
    );
    const first = adapter.asks[0];
    expect(first.prompt).toContain('Veteran "CLI software engineer" expert');
  });

  test("explain=true adds a plain-English preamble to the prompt", async () => {
    const qs = [{ id: "q1", text: "something?" }];
    const adapter = makeScriptedAskAdapter([makeQuestionsJson(qs)]);
    await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: true,
        subscriptionAuth: false,
        onQuestion: (_q) => Promise.resolve({ choice: "decide for me" }),
      },
      adapter,
    );
    const first = adapter.asks[0];
    expect(first.prompt.toLowerCase()).toMatch(
      /plain english|plain-english|non-technical|everyday/,
    );
  });

  // ---------- project-substance + ≤1 tech-stack guardrail (#NEW-INTERVIEW)
  //
  // The interview is for product-owner-shaped questions: target users,
  // jobs-to-be-done, v0.1 features, success criteria, edge cases,
  // constraints, out-of-scope. Tech-stack questions (language, DB,
  // framework, hosting) are capped at ONE total. The previous "language
  // FIRST question MUST" guardrail biased the entire interview toward
  // tech and was reported by users as the regression.

  test("idea with open language -> prompt does NOT mandate language-first; caps tech-stack at 1", async () => {
    const qs = [{ id: "q1", text: "something?" }];
    const adapter = makeScriptedAskAdapter([makeQuestionsJson(qs)]);
    await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        idea: "Build a TUI tool. Language choice open.",
        onQuestion: (_q) => Promise.resolve({ choice: "decide for me" }),
      },
      adapter,
    );
    const first = adapter.asks[0];
    // No "FIRST question MUST be language" mandate.
    expect(first.prompt).not.toMatch(
      /first question.*MUST.*language|language.*MUST.*first question/i,
    );
    // Tech-stack cap is present.
    expect(first.prompt.toLowerCase()).toMatch(
      /at most one tech-stack question|at most 1 tech-stack question/,
    );
  });

  test("idea with no explicit language -> prompt caps tech-stack at 1, focuses on substance", async () => {
    const qs = [{ id: "q1", text: "something?" }];
    const adapter = makeScriptedAskAdapter([makeQuestionsJson(qs)]);
    await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        idea: "Build a REST API service.",
        onQuestion: (_q) => Promise.resolve({ choice: "decide for me" }),
      },
      adapter,
    );
    const first = adapter.asks[0];
    expect(first.prompt).not.toMatch(
      /first question.*MUST.*language|language.*MUST.*first question/i,
    );
    expect(first.prompt.toLowerCase()).toMatch(
      /at most one tech-stack question|at most 1 tech-stack question/,
    );
    // Project-substance focus must be explicit.
    expect(first.prompt.toLowerCase()).toMatch(/project substance/);
    expect(first.prompt.toLowerCase()).toMatch(/target users|users/);
  });

  test("idea specifying a language -> tech-stack capped, language not re-opened", async () => {
    const qs = [{ id: "q1", text: "something?" }];
    const adapter = makeScriptedAskAdapter([makeQuestionsJson(qs)]);
    await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        idea: "Build a CLI in Rust.",
        onQuestion: (_q) => Promise.resolve({ choice: "decide for me" }),
      },
      adapter,
    );
    const first = adapter.asks[0];
    // Do not re-open language choice.
    expect(first.prompt.toLowerCase()).toMatch(/do not re-open|not re-open/);
    expect(first.prompt.toLowerCase()).toMatch(
      /at most one tech-stack question|at most 1 tech-stack question/,
    );
  });

  test("no idea provided -> still caps tech-stack at 1 and focuses on substance", async () => {
    const qs = [{ id: "q1", text: "something?" }];
    const adapter = makeScriptedAskAdapter([makeQuestionsJson(qs)]);
    await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        onQuestion: (_q) => Promise.resolve({ choice: "decide for me" }),
      },
      adapter,
    );
    const first = adapter.asks[0];
    expect(first.prompt.toLowerCase()).toMatch(
      /at most one tech-stack question|at most 1 tech-stack question/,
    );
    expect(first.prompt.toLowerCase()).toMatch(/project substance/);
  });
});

// ---------- timeout policy (raised SPEC §7 default) ----------
//
// Regression guard for the timeouts robustness pass: runInterview's lead
// `ask()` must default `opts.timeout` to 900_000 ms (15m). interview.ts
// is the ONLY interview coverage and it asserted persona/explain wiring
// and (separately) effort, but NEVER timeout — so a revert of the
// 900_000 default would have passed the suite green. Mirrors the
// effort-precedence shape so override-vs-default is symmetric.

describe("runInterview — lead timeout policy (SPEC §7)", () => {
  test("defaults opts.timeout to 900_000 ms (15m) when no override is given", async () => {
    const qs = [{ id: "q1", text: "something?" }];
    const adapter = makeScriptedAskAdapter([makeQuestionsJson(qs)]);
    await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        onQuestion: (_q) => Promise.resolve({ choice: "decide for me" }),
      },
      adapter,
    );
    expect(adapter.asks[0].opts.timeout).toBe(900_000);
  });

  test("a caller-supplied timeoutMs override reaches adapter.ask opts.timeout", async () => {
    const qs = [{ id: "q1", text: "something?" }];
    const adapter = makeScriptedAskAdapter([makeQuestionsJson(qs)]);
    await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        timeoutMs: 654_321,
        onQuestion: (_q) => Promise.resolve({ choice: "decide for me" }),
      },
      adapter,
    );
    expect(adapter.asks[0].opts.timeout).toBe(654_321);
  });

  test("effort AND timeout are BOTH correct on the same ask (no regression from the timeout raise)", async () => {
    const qs = [{ id: "q1", text: "something?" }];
    const adapter = makeScriptedAskAdapter([makeQuestionsJson(qs)]);
    await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        effort: "high" as EffortLevel,
        onQuestion: (_q) => Promise.resolve({ choice: "decide for me" }),
      },
      adapter,
    );
    expect(adapter.asks[0].opts.effort).toBe("high");
    expect(adapter.asks[0].opts.timeout).toBe(900_000);
  });

  test("override timeout threads through the dedupe re-prompt path too", async () => {
    // First lead response has duplicate question text -> one dedupe
    // re-prompt. Both asks must carry the override timeout, not the
    // default, on the retry leg.
    const dupJson = JSON.stringify({
      questions: [
        { id: "a", text: "same?", options: ["x", "y"] },
        { id: "b", text: "same?", options: ["x", "y"] },
      ],
    });
    const cleanJson = makeQuestionsJson([{ id: "q1", text: "distinct?" }]);
    const adapter = makeScriptedAskAdapter([dupJson, cleanJson]);
    await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        timeoutMs: 888_000,
        onQuestion: (_q) => Promise.resolve({ choice: "decide for me" }),
      },
      adapter,
    );
    expect(adapter.asks.length).toBe(2);
    expect(adapter.asks[0].opts.timeout).toBe(888_000);
    expect(adapter.asks[1].opts.timeout).toBe(888_000);
  });
});

// ---------- interview.json schema + round-trip ----------

describe("interview.json schema (SPEC §5 Phase 4)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "samospec-interview-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("round-trip: write -> read -> validate", () => {
    const file = path.join(tmp, "interview.json");
    const payload = InterviewFileSchema.parse({
      slug: "demo",
      persona: 'Veteran "CLI engineer" expert',
      generated_at: "2026-04-19T10:00:00Z",
      questions: [
        {
          id: "q1",
          text: "What framework?",
          options: [
            "Bun + TypeScript",
            "Node + TS",
            "decide for me",
            "not sure — defer",
            "custom",
          ],
        },
      ],
      answers: [{ id: "q1", choice: "custom", custom: "Deno + TS" }],
    });
    writeInterview(file, payload);
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain("Deno + TS");
    const reloaded = readInterview(file);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.answers[0].custom).toBe("Deno + TS");
    expect(reloaded!.persona).toBe('Veteran "CLI engineer" expert');
    expect(reloaded!.questions[0].options).toContain("decide for me");
  });

  test("invalid JSON structure is rejected", () => {
    expect(() =>
      InterviewFileSchema.parse({
        slug: "demo",
        persona: "not canonical form",
        generated_at: "2026-04-19T10:00:00Z",
        questions: [],
        answers: [],
      }),
    ).toThrow();
  });

  test("writeInterview refuses to write a malformed payload", () => {
    const file = path.join(tmp, "interview.json");
    expect(() =>
      // Deliberate type assertion to bypass TS: runtime validation must catch.
      writeInterview(file, {
        slug: "",
        persona: 'Veteran "CLI engineer" expert',
        generated_at: "bad",
        questions: [],
        answers: [],
      } as unknown as Parameters<typeof writeInterview>[1]),
    ).toThrow();
  });
});

// ---------- runInterview writes interview.json when a path is given ----------

describe("runInterview — interview.json write", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "samospec-interview-run-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("writes a validated interview.json at the given path", async () => {
    const qs = [
      { id: "q1", text: "what framework?" },
      { id: "q2", text: "what db?" },
    ];
    const adapter = makeScriptedAskAdapter([makeQuestionsJson(qs)]);
    const file = path.join(tmp, "interview.json");
    const out = await runInterview(
      {
        slug: "demo",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        outputPath: file,
        now: "2026-04-19T10:00:00Z",
        onQuestion: (q) => {
          if (q.id === "q1")
            return Promise.resolve({ choice: "custom", custom: "Bun" });
          return Promise.resolve({ choice: "decide for me" });
        },
      },
      adapter,
    );
    expect(out.answers.length).toBe(2);
    const reloaded = readInterview(file);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.answers[0].custom).toBe("Bun");
  });
});

// ---------- dedupe interview questions (samo.team #435) ----------
//
// Background: the interview LLM was observed to emit a duplicate question
// pair (Q5 = Q6 same text). The downstream persona/spec pipeline then
// hung forever on the duplicate. The fix has two layers:
//
//   1. Prompt-side: instruct the lead to produce DISTINCT questions.
//   2. Code-side: after parsing, detect duplicate question text and
//      re-prompt once with a stricter instruction. If the retry still
//      contains duplicates, fail with InterviewTerminalError (which the
//      caller surfaces as exit code 4 / lead_terminal — never a silent
//      hang).
//
// See samo.team #435 (blocks Sprint 4 goal #433).

describe("runInterview — dedupe interview questions (samo.team #435)", () => {
  test("prompt explicitly forbids duplicate / paraphrased questions", async () => {
    const qs = [{ id: "q1", text: "something?" }];
    const adapter = makeScriptedAskAdapter([makeQuestionsJson(qs)]);
    await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        onQuestion: (_q) => Promise.resolve({ choice: "decide for me" }),
      },
      adapter,
    );
    const first = adapter.asks[0];
    // Must call out distinctness explicitly.
    expect(first.prompt.toLowerCase()).toMatch(/distinct/);
    // Must forbid duplicates or paraphrases.
    expect(first.prompt.toLowerCase()).toMatch(/duplicate|paraphrase/);
  });

  test("duplicate-text in first response triggers a single re-prompt; final set is distinct", async () => {
    // First lead response: Q5 == Q6 same text (the exact #435 symptom).
    const dupQs = [
      { id: "q1", text: "Who are the target users?" },
      { id: "q2", text: "What is success?" },
      { id: "q3", text: "What is out of scope?" },
      { id: "q4", text: "What is the must-have feature?" },
      // Lead returned 6 (over cap) AND q4 == q5 same text.
      { id: "q5", text: "What is the must-have feature?" },
      { id: "q6", text: "What is the budget?" },
    ];
    // Second (retry) response: distinct.
    const distinctQs = [
      { id: "q1", text: "Who are the target users?" },
      { id: "q2", text: "What is success?" },
      { id: "q3", text: "What is out of scope?" },
      { id: "q4", text: "What is the must-have feature?" },
      { id: "q5", text: "What is the budget?" },
    ];
    const adapter = makeScriptedAskAdapter([
      makeQuestionsJsonExact(dupQs),
      makeQuestionsJsonExact(distinctQs),
    ]);
    const auto = autoAnswerFirst();
    const out = await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        onQuestion: auto.answer,
      },
      adapter,
    );
    // Exactly one re-prompt issued.
    expect(adapter.asks.length).toBe(2);
    // Retry prompt is stricter (mentions the duplicate problem).
    const retryPrompt = adapter.asks[1].prompt.toLowerCase();
    expect(retryPrompt).toMatch(/duplicate|distinct/);
    // Final user-visible question set is distinct (normalized).
    const seenTexts = out.questions.map((q) => q.text.trim().toLowerCase());
    const uniq = new Set(seenTexts);
    expect(uniq.size).toBe(seenTexts.length);
    // Answers wired through to all asked questions.
    expect(out.answers.length).toBe(out.questions.length);
  });

  test("paraphrase / whitespace-only duplicates are detected (normalized match)", async () => {
    // First response: two questions differing only by trailing whitespace
    // and case — normalization must catch them as duplicates.
    const dupQs = [
      { id: "q1", text: "Who are the target users?" },
      { id: "q2", text: "  who are the target users?  " },
    ];
    const distinctQs = [
      { id: "q1", text: "Who are the target users?" },
      { id: "q2", text: "What is success?" },
    ];
    const adapter = makeScriptedAskAdapter([
      makeQuestionsJsonExact(dupQs),
      makeQuestionsJsonExact(distinctQs),
    ]);
    const auto = autoAnswerFirst();
    await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        onQuestion: auto.answer,
      },
      adapter,
    );
    // Retry was triggered.
    expect(adapter.asks.length).toBe(2);
  });

  test("if both responses are duplicates, throws InterviewTerminalError (no hang)", async () => {
    const dupQs = [
      { id: "q1", text: "Who are the target users?" },
      { id: "q2", text: "Who are the target users?" },
    ];
    const adapter = makeScriptedAskAdapter([
      makeQuestionsJsonExact(dupQs),
      makeQuestionsJsonExact(dupQs),
    ]);
    const auto = autoAnswerFirst();
    let caught: unknown = null;
    try {
      await runInterview(
        {
          slug: "test",
          persona: 'Veteran "CLI engineer" expert',
          explain: false,
          subscriptionAuth: false,
          onQuestion: auto.answer,
        },
        adapter,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error).name).toBe("InterviewTerminalError");
    expect((caught as Error).message.toLowerCase()).toMatch(
      /duplicate|distinct/,
    );
    // Exactly 2 lead calls (initial + 1 retry — bail after retry).
    expect(adapter.asks.length).toBe(2);
    // No questions were ever offered to the user (we aborted before UI).
    expect(auto.saw.length).toBe(0);
  });

  test("distinct first response -> no re-prompt issued (regression guard)", async () => {
    const distinctQs = [
      { id: "q1", text: "Who are the target users?" },
      { id: "q2", text: "What is success?" },
      { id: "q3", text: "What is out of scope?" },
    ];
    const adapter = makeScriptedAskAdapter([
      makeQuestionsJsonExact(distinctQs),
    ]);
    const auto = autoAnswerFirst();
    await runInterview(
      {
        slug: "test",
        persona: 'Veteran "CLI engineer" expert',
        explain: false,
        subscriptionAuth: false,
        onQuestion: auto.answer,
      },
      adapter,
    );
    expect(adapter.asks.length).toBe(1);
    expect(auto.saw.length).toBe(3);
  });
});

// Helper: emit a questions JSON payload preserving exact text (the
// existing `makeQuestionsJson` templated text from id, which prevents
// duplicate text from surviving into the payload).
function makeQuestionsJsonExact(
  items: readonly { readonly id: string; readonly text: string }[],
): string {
  return JSON.stringify({
    questions: items.map((it) => ({
      id: it.id,
      text: it.text,
      options: [`option A for ${it.id}`, `option B for ${it.id}`],
    })),
  });
}
