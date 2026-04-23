// Copyright 2026 Nikolay Samokhvalov.

// Tests for `samospec new` Phase 4 — 5-question strategic interview
// (SPEC §5 Phase 4).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type { Adapter, AskInput, AskOutput } from "../../src/adapter/types.ts";
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

  test("idea with open language -> prompt includes language-first guardrail", async () => {
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
    expect(first.prompt).toMatch(
      /language.*open|open.*language|first question.*language|language.*first question/i,
    );
  });

  test("idea with no language -> prompt includes language-first guardrail", async () => {
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
    expect(first.prompt).toMatch(
      /first question.*language|language.*first question/i,
    );
  });

  test("idea specifying a language -> guardrail anchors on it, no lang-first mandate", async () => {
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
    // Should NOT mandate language as first question; should anchor on Rust
    expect(first.prompt).toMatch(/anchor|specified/i);
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
