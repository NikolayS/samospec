// Copyright 2026 Nikolay Samokhvalov.

// RED test for the ask()-wrapper schema conflict.
//
// Bug: buildAskPrompt() always prepends "Respond ONLY with { "answer": string
// ... }" before the caller's prompt. When persona.ts / interview.ts call
// adapter.ask() with a domain prompt that already contains its own
// "Respond ONLY with { "persona", "rationale" }" (or "questions") directive,
// the model sees TWO contradictory schema instructions. It picks one shape
// (e.g. { "persona", "rationale" }) but AskOutputSchema.parse() requires
// { "answer": string } → ZodError → PersonaTerminalError / exit 4.
//
// Fix: introduce adapter.structuredAsk() whose prompt builder does NOT inject
// the outer { answer } wrapper. The caller's prompt already carries the full
// schema instruction. Persona + interview call sites switch to structuredAsk;
// the result is the raw domain JSON string (parsed by the caller's own schema).
//
// These tests are assertable without any LLM call — they validate the
// PROMPT TEXT produced by the builders (pure functions).

import { describe, expect, test } from "bun:test";

import {
  buildAskPrompt,
  buildStructuredAskPrompt,
} from "../../src/adapter/claude.ts";
import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type { AskInput, StructuredAskInput } from "../../src/adapter/types.ts";

// The exact phrase both prompt builders inject.
const RESPOND_ONLY_PATTERN = /Respond ONLY with/gi;

function countOccurrences(haystack: string, re: RegExp): number {
  const global = new RegExp(re.source, "gi");
  return (haystack.match(global) ?? []).length;
}

// A domain prompt that has its own "Respond ONLY with" directive (like
// persona.ts:155-158 and interview.ts:239-242 do).
const DOMAIN_PROMPT_WITH_SCHEMA =
  'You are the samospec lead. Given a rough idea, propose a single expert persona.\n\n' +
  'Respond ONLY with a JSON object:\n' +
  '  { "persona": "Veteran \\"<skill>\\" expert", "rationale": "..." }\n' +
  'Do not wrap in code fences.\n\n' +
  'Idea:\nA recipe sharing app\n';

function makeAskInputWithDomainPrompt(): AskInput {
  return {
    prompt: DOMAIN_PROMPT_WITH_SCHEMA,
    context: "",
    opts: { effort: "max", timeout: 120_000 },
  };
}

function makeStructuredAskInput(): StructuredAskInput {
  return {
    prompt: DOMAIN_PROMPT_WITH_SCHEMA,
    context: "",
    opts: { effort: "max", timeout: 120_000 },
  };
}

// ---------- 1. Demonstrate the conflict in buildAskPrompt ----------

describe("buildAskPrompt — schema conflict (BEFORE fix)", () => {
  test("buildAskPrompt wraps the caller prompt with its own Respond-ONLY directive", () => {
    const prompt = buildAskPrompt(makeAskInputWithDomainPrompt());
    // The outer wrapper always adds one "Respond ONLY with"
    const count = countOccurrences(prompt, RESPOND_ONLY_PATTERN);
    // The resulting prompt has at least 2: one from buildAskPrompt wrapper,
    // one from the domain prompt inside.
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("buildAskPrompt outer wrapper requires { answer: string } schema", () => {
    const prompt = buildAskPrompt(makeAskInputWithDomainPrompt());
    expect(prompt).toContain('"answer"');
    expect(prompt).toContain('"usage"');
  });

  test("buildAskPrompt outer wrapper conflicts with domain { persona, rationale } schema", () => {
    const prompt = buildAskPrompt(makeAskInputWithDomainPrompt());
    // Both schemas are present in the combined prompt — a clear contradiction.
    expect(prompt).toContain('"answer"');
    expect(prompt).toContain('"persona"');
    // Model sees two contradictory "Respond ONLY with" — non-deterministic failure.
  });
});

// ---------- 2. buildStructuredAskPrompt — NO outer {answer} wrapper ----------

describe("buildStructuredAskPrompt — no outer wrapper (AFTER fix)", () => {
  test("buildStructuredAskPrompt is exported from claude.ts", () => {
    expect(typeof buildStructuredAskPrompt).toBe("function");
  });

  test("buildStructuredAskPrompt does NOT inject the outer { answer } wrapper", () => {
    const prompt = buildStructuredAskPrompt(makeStructuredAskInput());
    // The outer { answer } directive must NOT be present.
    expect(prompt).not.toContain('"answer"');
  });

  test("buildStructuredAskPrompt contains exactly ONE Respond-ONLY directive", () => {
    const prompt = buildStructuredAskPrompt(makeStructuredAskInput());
    const count = countOccurrences(prompt, RESPOND_ONLY_PATTERN);
    expect(count).toBe(1);
  });

  test("buildStructuredAskPrompt preserves the caller-supplied domain prompt verbatim", () => {
    const prompt = buildStructuredAskPrompt(makeStructuredAskInput());
    // The domain schema instruction must survive intact.
    expect(prompt).toContain('"persona"');
    expect(prompt).toContain('"rationale"');
    expect(prompt).toContain("Idea:\nA recipe sharing app");
  });
});

// ---------- 3. Adapter interface has structuredAsk ----------

describe("Adapter interface — structuredAsk method", () => {
  test("createFakeAdapter returns an adapter with a structuredAsk method", () => {
    const adapter = createFakeAdapter();
    expect(typeof adapter.structuredAsk).toBe("function");
  });

  test("structuredAsk returns a StructuredAskOutput with a rawJson string field", async () => {
    const adapter = createFakeAdapter({
      structuredAsk: { rawJson: '{"persona":"Veteran \\"Test\\" expert","rationale":"test"}', usage: null, effort_used: "max" },
    });
    const result = await adapter.structuredAsk(makeStructuredAskInput());
    expect(typeof result.rawJson).toBe("string");
    expect(result.rawJson).toContain("persona");
  });

  test("structuredAsk rawJson is parseable JSON", async () => {
    const domainJson = '{"questions":[{"id":"q1","text":"What is the target user?","options":["A","B"]}]}';
    const adapter = createFakeAdapter({
      structuredAsk: { rawJson: domainJson, usage: null, effort_used: "max" },
    });
    const result = await adapter.structuredAsk(makeStructuredAskInput());
    const parsed = JSON.parse(result.rawJson);
    expect(Array.isArray(parsed.questions)).toBe(true);
  });
});

// ---------- 4. Persona call site uses structuredAsk (no double-wrap) ----------

describe("persona call site — uses structuredAsk, no { answer } wrapper collision", () => {
  test("proposePersona succeeds when structuredAsk returns raw { persona, rationale } JSON", async () => {
    // Import proposePersona dynamically to avoid top-level import errors
    // in the RED test phase when the interface doesn't exist yet.
    const { proposePersona } = await import("../../src/cli/persona.ts");

    const personaJson = '{"persona":"Veteran \\"Recipe Developer\\" expert","rationale":"Core skill for recipe app"}';
    const adapter = createFakeAdapter({
      structuredAsk: { rawJson: personaJson, usage: null, effort_used: "max" },
    });

    const result = await proposePersona(
      {
        idea: "A recipe sharing app",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );

    expect(result.persona).toBe('Veteran "Recipe Developer" expert');
    expect(result.skill).toBe("Recipe Developer");
  });
});
