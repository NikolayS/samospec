// Copyright 2026 Nikolay Samokhvalov.

// Tests for `samospec new` Phase 2 — persona proposal (SPEC §5 Phase 2,
// §7 lead adapter persona wiring, §11 subscription-auth UX copy).

import { describe, expect, test } from "bun:test";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type {
  Adapter,
  AskInput,
  AskOutput,
  AuthStatus,
  EffortLevel,
} from "../../src/adapter/types.ts";
import {
  PERSONA_FORM_RE,
  SUBSCRIPTION_AUTH_MESSAGE,
  proposePersona,
  formatPersonaString,
} from "../../src/cli/persona.ts";

function askOutputWithAnswer(answer: string): AskOutput {
  return { answer, usage: null, effort_used: "max" };
}

interface ScriptedAskAdapter extends Adapter {
  readonly asks: readonly AskInput[];
}

function makeScriptedAskAdapter(
  answers: readonly string[],
  overrides: Partial<{
    auth: AuthStatus;
  }> = {},
): ScriptedAskAdapter {
  const base = createFakeAdapter(
    overrides.auth !== undefined ? { auth: overrides.auth } : {},
  );
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
    const adapter = makeScriptedAskAdapter([
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

  test("ask() is invoked with a system prompt mentioning the persona form", async () => {
    const adapter = makeScriptedAskAdapter([
      JSON.stringify({
        persona: 'Veteran "platform engineer" expert',
        rationale: "ok",
      }),
    ]);
    await proposePersona(
      {
        idea: "some idea",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );

    expect(adapter.asks.length).toBeGreaterThan(0);
    const first = adapter.asks[0];
    expect(first.prompt).toContain("Veteran");
    expect(first.prompt).toContain("expert");
    expect(first.opts.effort).toBe("max");
  });
});

// ---------- confirm / edit / replace ----------

describe("proposePersona — confirm / edit / replace", () => {
  test("kind: edit overrides the skill and keeps the rationale", async () => {
    const adapter = makeScriptedAskAdapter([
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
    const adapter = makeScriptedAskAdapter([
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
    const adapter = makeScriptedAskAdapter([
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
    const adapter = makeScriptedAskAdapter([
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
        idea: "idea",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );
    expect(result.persona).toBe('Veteran "CLI software engineer" expert');
    // Exactly one repair attempt was made (so 2 total ask calls).
    expect(adapter.asks.length).toBe(2);
  });

  test("two malformed responses in a row => throws PersonaTerminalError", async () => {
    const adapter = makeScriptedAskAdapter([
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
    const adapter = makeScriptedAskAdapter([
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
    const adapter = makeScriptedAskAdapter([
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
    const adapter = makeScriptedAskAdapter([
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
    const adapter = makeScriptedAskAdapter([
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
    const first = adapter.asks[0];
    expect(first.prompt.toLowerCase()).toMatch(
      /plain english|plain-english|non-technical|everyday/,
    );
  });

  test("explain=false does NOT include the plain-English preamble", async () => {
    const adapter = makeScriptedAskAdapter([
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
    const first = adapter.asks[0];
    expect(first.prompt.toLowerCase()).not.toMatch(
      /plain english preamble|non-technical/,
    );
  });
});

// ---------- effort max policy ----------

describe("proposePersona — lead effort policy (SPEC §11)", () => {
  test("defaults to effort=max, honors override", async () => {
    const adapter = makeScriptedAskAdapter([
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
    expect(adapter.asks[0].opts.effort).toBe("high");
  });
});
