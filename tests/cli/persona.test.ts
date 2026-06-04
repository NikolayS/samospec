// Copyright 2026 Nikolay Samokhvalov.

// Tests for `samospec new` Phase 2 — persona proposal (SPEC §5 Phase 2,
// §7 lead adapter persona wiring, §11 subscription-auth UX copy).

import { describe, expect, test } from "bun:test";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type {
  Adapter,
  AuthStatus,
  EffortLevel,
  StructuredAskInput,
  StructuredAskOutput,
} from "../../src/adapter/types.ts";
import {
  PERSONA_FORM_RE,
  SUBSCRIPTION_AUTH_MESSAGE,
  proposePersona,
  formatPersonaString,
} from "../../src/cli/persona.ts";

function structuredAskOutputWithRawJson(rawJson: string): StructuredAskOutput {
  return { rawJson, usage: null, effort_used: "max" };
}

interface ScriptedStructuredAskAdapter extends Adapter {
  readonly structuredAsks: readonly StructuredAskInput[];
}

function makeScriptedStructuredAskAdapter(
  rawJsonAnswers: readonly string[],
  overrides: Partial<{
    auth: AuthStatus;
  }> = {},
): ScriptedStructuredAskAdapter {
  const base = createFakeAdapter(
    overrides.auth !== undefined ? { auth: overrides.auth } : {},
  );
  const structuredAsks: StructuredAskInput[] = [];
  let call = 0;
  const scripted: Adapter = {
    ...base,
    structuredAsk: (
      input: StructuredAskInput,
    ): Promise<StructuredAskOutput> => {
      structuredAsks.push(input);
      const rawJson =
        rawJsonAnswers[call] ??
        rawJsonAnswers[rawJsonAnswers.length - 1] ??
        "{}";
      call += 1;
      return Promise.resolve(structuredAskOutputWithRawJson(rawJson));
    },
  };
  const result = Object.assign(scripted, {
    structuredAsks,
  }) as ScriptedStructuredAskAdapter;
  return result;
}

// ---------- persona form regex ----------

describe("persona form regex (SPEC §5 Phase 2)", () => {
  test('accepts canonical `Veteran "<skill>" expert`', () => {
    expect(PERSONA_FORM_RE.test('Veteran "CLI software engineer" expert')).toBe(
      true,
    );
  });

  test("accepts multi-word skills with punctuation", () => {
    expect(
      PERSONA_FORM_RE.test(
        'Veteran "distributed systems / SRE specialist" expert',
      ),
    ).toBe(true);
  });

  test("rejects missing quotes", () => {
    expect(PERSONA_FORM_RE.test("Veteran CLI software engineer expert")).toBe(
      false,
    );
  });

  test("rejects wrong word order", () => {
    expect(PERSONA_FORM_RE.test('Expert "CLI software engineer" veteran')).toBe(
      false,
    );
  });

  test("rejects empty skill", () => {
    expect(PERSONA_FORM_RE.test('Veteran "" expert')).toBe(false);
  });

  test("rejects trailing garbage", () => {
    expect(
      PERSONA_FORM_RE.test('Veteran "CLI engineer" expert and also a sage'),
    ).toBe(false);
  });

  test("formatPersonaString wraps the skill correctly", () => {
    expect(formatPersonaString("CLI software engineer")).toBe(
      'Veteran "CLI software engineer" expert',
    );
  });
});

// ---------- happy path ----------

describe("proposePersona — happy path", () => {
  test("returns { persona, rationale } when lead returns canonical form + rationale", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "CLI software engineer" expert',
        rationale:
          "The idea is a command-line tool; this persona covers design and UX.",
      }),
    ]);
    const result = await proposePersona(
      {
        idea: "a CLI for turning ideas into specs",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );

    expect(result.persona).toBe('Veteran "CLI software engineer" expert');
    expect(result.rationale.length).toBeGreaterThan(0);
    expect(result.accepted).toBe(true);
    expect(result.skill).toBe("CLI software engineer");
  });

  test("structuredAsk() is invoked with a system prompt mentioning the persona form", async () => {
    const idea = "some idea";
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "platform engineer" expert',
        rationale: "ok",
      }),
    ]);
    await proposePersona(
      {
        idea,
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );

    expect(adapter.structuredAsks.length).toBeGreaterThan(0);
    const first = adapter.structuredAsks[0];
    expect(first.prompt).toContain("Veteran");
    expect(first.prompt).toContain("expert");
    // The idea text is baked into the domain prompt (not a separate field).
    expect(first.prompt).toContain(idea);
    // Unified default: high (was "max" before the unified-effort knob).
    expect(first.opts.effort).toBe("high");
  });
});

// ---------- confirm / edit / replace ----------

describe("proposePersona — confirm / edit / replace", () => {
  test("kind: edit overrides the skill and keeps the rationale", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "CLI software engineer" expert',
        rationale: "reasoning",
      }),
    ]);
    const result = await proposePersona(
      {
        idea: "idea",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "edit", skill: "distributed systems engineer" },
      },
      adapter,
    );
    expect(result.skill).toBe("distributed systems engineer");
    expect(result.persona).toBe(
      'Veteran "distributed systems engineer" expert',
    );
    expect(result.accepted).toBe(true);
  });

  test("kind: replace overrides the entire persona string", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "CLI software engineer" expert',
        rationale: "reasoning",
      }),
    ]);
    const result = await proposePersona(
      {
        idea: "idea",
        explain: false,
        subscriptionAuth: false,
        choice: {
          kind: "replace",
          persona: 'Veteran "staff-level platform engineer" expert',
        },
      },
      adapter,
    );
    expect(result.persona).toBe(
      'Veteran "staff-level platform engineer" expert',
    );
    expect(result.skill).toBe("staff-level platform engineer");
    expect(result.accepted).toBe(true);
  });

  test("kind: replace rejects an ill-formed persona (throws)", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "CLI software engineer" expert',
        rationale: "reasoning",
      }),
    ]);
    let caught: unknown = null;
    try {
      await proposePersona(
        {
          idea: "idea",
          explain: false,
          subscriptionAuth: false,
          choice: { kind: "replace", persona: "CLI engineer" },
        },
        adapter,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught).toBeInstanceOf(Error);
  });
});

// ---------- schema repair + terminal path ----------

describe("proposePersona — schema repair + lead_terminal", () => {
  test("first response malformed, second response valid: accepts second", async () => {
    const idea = "idea";
    const adapter = makeScriptedStructuredAskAdapter([
      // Malformed: missing quotes around skill.
      JSON.stringify({
        persona: "Veteran CLI software engineer expert",
        rationale: "r",
      }),
      // Valid repair.
      JSON.stringify({
        persona: 'Veteran "CLI software engineer" expert',
        rationale: "r2",
      }),
    ]);
    const result = await proposePersona(
      {
        idea,
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );
    expect(result.persona).toBe('Veteran "CLI software engineer" expert');
    // Exactly one repair attempt was made (so 2 total structuredAsk calls).
    expect(adapter.structuredAsks.length).toBe(2);
    // The idea is baked into the prompt, not a separate field.
    expect(adapter.structuredAsks[0].prompt).toContain(idea);
    expect(adapter.structuredAsks[1].prompt).toContain(idea);
  });

  test("two malformed responses in a row => throws PersonaTerminalError", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({ persona: "nope", rationale: "bad" }),
      JSON.stringify({ persona: "still bad", rationale: "worse" }),
    ]);
    let caught: unknown = null;
    try {
      await proposePersona(
        {
          idea: "idea",
          explain: false,
          subscriptionAuth: false,
          choice: { kind: "accept" },
        },
        adapter,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/lead_terminal|schema|persona/i);
  });

  test("non-JSON response => throws PersonaTerminalError", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      "this is not JSON at all",
      "still not JSON",
    ]);
    let caught: unknown = null;
    try {
      await proposePersona(
        {
          idea: "idea",
          explain: false,
          subscriptionAuth: false,
          choice: { kind: "accept" },
        },
        adapter,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/lead_terminal|schema|persona/i);
  });
});

// ---------- subscription-auth copy ----------

describe("proposePersona — subscription-auth UX copy (SPEC §11)", () => {
  test("subscriptionAuth=true surfaces the explicit message via onNotice callback", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "CLI software engineer" expert',
        rationale: "r",
      }),
    ]);
    const notices: string[] = [];
    await proposePersona(
      {
        idea: "idea",
        explain: false,
        subscriptionAuth: true,
        choice: { kind: "accept" },
        onNotice: (n) => notices.push(n),
      },
      adapter,
    );
    expect(notices.some((n) => n === SUBSCRIPTION_AUTH_MESSAGE)).toBe(true);
    expect(SUBSCRIPTION_AUTH_MESSAGE).toContain("subscription-auth");
  });

  test("subscriptionAuth=false suppresses the message", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "CLI software engineer" expert',
        rationale: "r",
      }),
    ]);
    const notices: string[] = [];
    await proposePersona(
      {
        idea: "idea",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
        onNotice: (n) => notices.push(n),
      },
      adapter,
    );
    expect(notices.every((n) => n !== SUBSCRIPTION_AUTH_MESSAGE)).toBe(true);
  });
});

// ---------- --explain flag ----------

describe("proposePersona — --explain flag (SPEC §4 secondary ICP)", () => {
  test("explain=true adds a plain-English preamble to the prompt", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "CLI software engineer" expert',
        rationale: "r",
      }),
    ]);
    await proposePersona(
      {
        idea: "idea",
        explain: true,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );
    const first = adapter.structuredAsks[0];
    expect(first.prompt.toLowerCase()).toMatch(
      /plain english|plain-english|non-technical|everyday/,
    );
  });

  test("explain=false does NOT include the plain-English preamble", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "CLI software engineer" expert',
        rationale: "r",
      }),
    ]);
    await proposePersona(
      {
        idea: "idea",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );
    const first = adapter.structuredAsks[0];
    expect(first.prompt.toLowerCase()).not.toMatch(
      /plain english preamble|non-technical/,
    );
  });
});

// ---------- job-title shape guidance (#367) ----------

describe("proposePersona — job-title shape guidance (#367)", () => {
  test("prompt asks for a 2-4 word job-title-shaped role", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "Recipe Developer" expert',
        rationale: "r",
      }),
    ]);
    await proposePersona(
      {
        idea: "idea",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );
    const prompt = adapter.structuredAsks[0].prompt;
    // Must mention the 2-4 word constraint.
    expect(prompt).toMatch(/2[–—-]4\s+words/i);
    // Must instruct Title Case.
    expect(prompt.toLowerCase()).toContain("title case");
    // Must explicitly name "job title" / "role" framing.
    expect(prompt.toLowerCase()).toMatch(/job title|role label|business card/);
  });

  test("prompt names person-noun endings (Developer, Designer, etc.)", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "Recipe Developer" expert',
        rationale: "r",
      }),
    ]);
    await proposePersona(
      {
        idea: "idea",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );
    const prompt = adapter.structuredAsks[0].prompt;
    // At least three of these person-nouns should be enumerated as
    // accepted endings.
    const personNouns = [
      "Developer",
      "Designer",
      "Manager",
      "Advisor",
      "Counselor",
      "Strategist",
      "Analyst",
      "Architect",
      "Engineer",
      "Consultant",
    ];
    const hits = personNouns.filter((n) => prompt.includes(n));
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  test("prompt forbids descriptive task / domain phrases", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "Recipe Developer" expert',
        rationale: "r",
      }),
    ]);
    await proposePersona(
      {
        idea: "idea",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );
    const prompt = adapter.structuredAsks[0].prompt;
    const lower = prompt.toLowerCase();
    // Must call out the forbidden -ing / -ment / -ence task-shaped
    // suffixes by listing some of them verbatim.
    const badEndings = [
      "planning",
      "development",
      "analysis",
      "science",
      "engineering",
    ];
    const flagged = badEndings.filter((s) => lower.includes(s));
    expect(flagged.length).toBeGreaterThanOrEqual(3);
  });

  test("prompt includes few-shot good/bad examples for shape", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "Recipe Developer" expert',
        rationale: "r",
      }),
    ]);
    await proposePersona(
      {
        idea: "idea",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );
    const prompt = adapter.structuredAsks[0].prompt;
    // Good examples: short job-title-shaped roles (canonically wrapped
    // in the Veteran "<skill>" expert form).
    expect(prompt).toContain('Veteran "Recipe Developer" expert');
    expect(prompt).toContain('Veteran "Food Scientist" expert');
    // Bad examples: descriptive task/domain phrases that the user
    // explicitly does NOT want.
    expect(prompt).toContain("Culinary recipe development and food science");
    expect(prompt.toLowerCase()).toContain(
      "higher-education academic planning",
    );
  });
});

// ---------- effort policy (unified default) ----------

describe("proposePersona — lead effort policy", () => {
  test("defaults to effort=high (unified default, not max)", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "CLI software engineer" expert',
        rationale: "r",
      }),
    ]);
    const opts = {
      idea: "idea",
      explain: false,
      subscriptionAuth: false,
      choice: { kind: "accept" as const },
    };
    await proposePersona(opts, adapter);
    expect(adapter.structuredAsks[0].opts.effort).toBe("high");
  });

  test("honors an explicit effort override", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "CLI software engineer" expert',
        rationale: "r",
      }),
    ]);
    const opts = {
      idea: "idea",
      explain: false,
      subscriptionAuth: false,
      choice: { kind: "accept" as const },
      effort: "high" as EffortLevel,
    };
    await proposePersona(opts, adapter);
    expect(adapter.structuredAsks[0].opts.effort).toBe("high");
  });
});

// ---------- timeout policy (raised SPEC §7 default) ----------
//
// Regression guard for the timeouts robustness pass: persona's lead
// `structuredAsk()` must default `opts.timeout` to 900_000 ms (15m) so a
// slow max-effort lead is not preempted mid-flight.

describe("proposePersona — lead timeout policy (SPEC §7)", () => {
  test("defaults opts.timeout to 900_000 ms (15m) when no override is given", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "CLI software engineer" expert',
        rationale: "r",
      }),
    ]);
    await proposePersona(
      {
        idea: "idea",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );
    expect(adapter.structuredAsks[0].opts.timeout).toBe(900_000);
  });

  test("a caller-supplied timeoutMs override reaches adapter.structuredAsk opts.timeout", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "CLI software engineer" expert',
        rationale: "r",
      }),
    ]);
    await proposePersona(
      {
        idea: "idea",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
        timeoutMs: 123_456,
      },
      adapter,
    );
    expect(adapter.structuredAsks[0].opts.timeout).toBe(123_456);
  });

  test("the 900_000 default and the override both apply on the repair retry too", async () => {
    // First answer is malformed -> triggers ONE repair retry. The
    // timeout override must thread through to BOTH structuredAsks (the
    // default would otherwise silently re-appear on the retry path).
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({ persona: "not canonical", rationale: "r1" }),
      JSON.stringify({
        persona: 'Veteran "CLI software engineer" expert',
        rationale: "r2",
      }),
    ]);
    await proposePersona(
      {
        idea: "idea",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
        timeoutMs: 777_000,
      },
      adapter,
    );
    expect(adapter.structuredAsks.length).toBe(2);
    expect(adapter.structuredAsks[0].opts.timeout).toBe(777_000);
    expect(adapter.structuredAsks[1].opts.timeout).toBe(777_000);
  });

  test("effort AND timeout are BOTH correct on the same structuredAsk (no regression from the timeout raise)", async () => {
    // Combined assertion: bumping the timeout default must not regress
    // effort threading, and vice versa.
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "CLI software engineer" expert',
        rationale: "r",
      }),
    ]);
    await proposePersona(
      {
        idea: "idea",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
        effort: "high",
      },
      adapter,
    );
    expect(adapter.structuredAsks[0].opts.effort).toBe("high");
    expect(adapter.structuredAsks[0].opts.timeout).toBe(900_000);
  });
});
