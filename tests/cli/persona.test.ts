// Copyright 2026 Nikolay Samokhvalov.

// Tests for `samospec new` Phase 2 — persona proposal (SPEC §5 Phase 2,
// §7 lead adapter persona wiring, §11 subscription-auth UX copy).

import { describe, expect, test } from "bun:test";
import personaNameFixtures from "../fixtures/persona-name-fixtures.json";

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
  PRACTITIONER_NOUNS,
  SOFTWARE_ROLE_RE,
  PersonaTerminalError,
  SUBSCRIPTION_AUTH_MESSAGE,
  coerceSoftwareEngineerPersona,
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
  rawJsonAnswers: readonly (string | Error)[],
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
      const answer =
        rawJsonAnswers[call] ??
        rawJsonAnswers[rawJsonAnswers.length - 1] ??
        "{}";
      call += 1;
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(structuredAskOutputWithRawJson(answer));
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

    expect(result.persona).toBe('Veteran "CLI Software Engineer" expert');
    expect(result.rationale.length).toBeGreaterThan(0);
    expect(result.accepted).toBe(true);
    expect(result.skill).toBe("CLI Software Engineer");
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
  test("valid practitioner then malformed repair coerces the first answer", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "Strength & Conditioning Coach" expert',
        rationale: "first rationale",
      }),
      "not JSON",
    ]);
    const result = await proposePersona(
      {
        idea: "a strength-coaching app",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );
    expect(result.persona).toBe(
      'Veteran "Strength & Conditioning Software Engineer" expert',
    );
    expect(result.rationale).toBe("first rationale");
  });

  test("valid practitioner then repair adapter error coerces the first answer", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "Strength & Conditioning Coach" expert',
        rationale: "first rationale",
      }),
      new Error("repair unavailable"),
    ]);
    const result = await proposePersona(
      {
        idea: "a strength-coaching app",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );
    expect(result.persona).toBe(
      'Veteran "Strength & Conditioning Software Engineer" expert',
    );
    expect(result.rationale).toBe("first rationale");
  });

  test("malformed first answer keeps terminal error reasons", async () => {
    for (const [repair, reason] of [
      ["not JSON", "schema_violation"],
      [new Error("repair unavailable"), "adapter_error"],
    ] as const) {
      const adapter = makeScriptedStructuredAskAdapter(["not JSON", repair]);
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
        throw new Error("expected proposePersona to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(PersonaTerminalError);
        expect((error as PersonaTerminalError).reason).toBe(reason);
      }
    }
  });

  test("a practitioner title is repaired to a software engineer title", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "Strength & Conditioning Coach" expert',
        rationale: "r1",
      }),
      JSON.stringify({
        persona: 'Veteran "Strength & Conditioning Software Engineer" expert',
        rationale: "r2",
      }),
    ]);

    const result = await proposePersona(
      {
        idea: "a gym-coaching website",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );

    expect(result.persona).toBe(
      'Veteran "Strength & Conditioning Software Engineer" expert',
    );
    expect(adapter.structuredAsks).toHaveLength(2);
    expect(adapter.structuredAsks[1].prompt).toContain(
      "described a practitioner, not a software engineer",
    );
    expect(adapter.structuredAsks[1].prompt).toContain(
      "The title must describe a software engineer who is an expert in " +
        "the customer's field",
    );
  });

  test("two practitioner titles are deterministically coerced", async () => {
    const coachAnswer = JSON.stringify({
      persona: 'Veteran "Strength & Conditioning Coach" expert',
      rationale: "gym domain",
    });
    const adapter = makeScriptedStructuredAskAdapter([
      coachAnswer,
      coachAnswer,
    ]);

    const result = await proposePersona(
      {
        idea: "a gym-coaching website",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );

    expect(result.persona).toBe(
      'Veteran "Strength & Conditioning Software Engineer" expert',
    );
    expect(result.skill).toBe("Strength & Conditioning Software Engineer");
    expect(adapter.structuredAsks).toHaveLength(2);
  });

  test("an unacceptable repair falls back to the first valid answer and rationale", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "Family Law Attorney" expert',
        rationale: "first rationale",
      }),
      JSON.stringify({
        persona: 'Veteran "Artisan Bakery Owner" expert',
        rationale: "repair rationale",
      }),
    ]);

    const result = await proposePersona(
      {
        idea: "a family-law intake tool",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );

    expect(result.persona).toBe(
      'Veteran "Family Law Software Engineer" expert',
    );
    expect(result.rationale).toBe("first rationale");
    expect(adapter.structuredAsks).toHaveLength(2);
  });

  test("an engineer title is accepted without a repair call", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "Fitness Coaching Software Engineer" expert',
        rationale: "software and domain expertise",
      }),
    ]);

    const result = await proposePersona(
      {
        idea: "a gym-coaching website",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );

    expect(result.persona).toBe(
      'Veteran "Fitness Coaching Software Engineer" expert',
    );
    expect(adapter.structuredAsks).toHaveLength(1);
  });

  test("accepted app-side engineer variants need no repair", async () => {
    const titles = [
      "Web Developer",
      "Full-Stack Developer",
      "Front-End Engineer",
      "Backend Engineer",
      "Mobile App Developer",
      "CLI Engineer",
      "Software Developer",
      "App Developer",
    ];
    for (const title of titles) {
      const adapter = makeScriptedStructuredAskAdapter([
        JSON.stringify({ persona: formatPersonaString(title), rationale: "r" }),
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
      expect(result.skill).toBe(title);
      expect(adapter.structuredAsks).toHaveLength(1);
    }
  });

  test("accepted engineer titles need no repair when the guard leaves them unchanged", async () => {
    for (const title of [
      "Strength & Conditioning Software Engineer",
      "Machine Learning Engineer",
    ]) {
      const answer = JSON.stringify({
        persona: formatPersonaString(title),
        rationale: "r",
      });
      const adapter = makeScriptedStructuredAskAdapter([answer, answer]);
      const result = await proposePersona(
        {
          idea: "idea",
          explain: false,
          subscriptionAuth: false,
          choice: { kind: "accept" },
        },
        adapter,
      );
      expect(adapter.structuredAsks).toHaveLength(1);
      expect(result.skill).toBe(title);
    }
  });

  test("coercion strips role suffixes, stays bounded, and is idempotent", () => {
    const cases = [
      ["Data Engineer", "Data Engineer"],
      ["Software Architect", "Website Software Engineer"],
      ["Coach", "Website Software Engineer"],
      ["Real-Estate Agent", "Real-Estate Software Engineer"],
      ["Тренер по фитнесу", "Website Software Engineer"],
    ] as const;
    for (const [input, expected] of cases) {
      const first = coerceSoftwareEngineerPersona(formatPersonaString(input));
      const skill = PERSONA_FORM_RE.exec(first)?.[1] ?? "";
      expect(skill).toBe(expected);
      expect(skill.length).toBeLessThanOrEqual(60);
      expect(coerceSoftwareEngineerPersona(first)).toBe(first);
    }
  });

  test("clean domains, seniority, role casing, and Chief of Staff mirror the app guard", () => {
    const cases = [
      ["Fitness", "Fitness Software Engineer"],
      ["College Admissions", "College Admissions Software Engineer"],
      ["Fitness SOFTWARE ENGINEER", "Fitness Software Engineer"],
      ["Senior Web Developer", "Senior Web Developer"],
      ["Fitness Senior Web Developer", "Fitness Senior Web Developer"],
      ["Chief of Staff", "Website Software Engineer"],
    ] as const;
    for (const [input, expected] of cases) {
      expect(
        PERSONA_FORM_RE.exec(coerceSoftwareEngineerPersona(input))?.[1],
      ).toBe(expected);
    }
  });

  test("persona is a software engineer expert in the customer's domain (3 domains)", async () => {
    const cases = [
      [
        "a strength-coaching app",
        "Strength & Conditioning Coach",
        "Strength & Conditioning Software Engineer",
      ],
      [
        "a neighbourhood bakery website",
        "Artisan Bakery Owner",
        "Artisan Bakery Software Engineer",
      ],
      [
        "a family-law intake tool",
        "Family Law Attorney",
        "Family Law Software Engineer",
      ],
    ] as const;
    for (const [idea, practitioner, expected] of cases) {
      const answer = JSON.stringify({
        persona: formatPersonaString(practitioner),
        rationale: "r",
      });
      const adapter = makeScriptedStructuredAskAdapter([answer, answer]);
      const result = await proposePersona(
        {
          idea,
          explain: false,
          subscriptionAuth: false,
          choice: { kind: "accept" },
        },
        adapter,
      );
      expect(result.skill).toBe(expected);
      expect(result.skill).not.toMatch(/Coach|Owner|Attorney/i);
      expect(adapter.structuredAsks[0].prompt).toContain(
        "The persona is ALWAYS a software engineer who specialises in " +
          "the idea's domain",
      );
    }
  });

  test("matches every pinned SAMO Team app persona-name fixture", () => {
    const practitionerPattern = new RegExp(
      `(?:^|[^\\p{L}\\p{N}_])(?:${PRACTITIONER_NOUNS.join("|")})(?=$|[^\\p{L}\\p{N}_])`,
      "iu",
    );
    for (const [input, expected] of personaNameFixtures) {
      const actualPersona = coerceSoftwareEngineerPersona(input);
      const actual = PERSONA_FORM_RE.exec(actualPersona)?.[1] ?? "";
      expect(actual).toBe(expected);
      expect(actual.length).toBeGreaterThan(0);
      expect(actual.length).toBeLessThanOrEqual(60);
      expect(coerceSoftwareEngineerPersona(actualPersona)).toBe(actualPersona);
      expect(actual).toMatch(/^[\p{Lu}\p{Lt}\d]/u);
      expect(practitionerPattern.test(actual)).toBe(false);
      if (actual !== "Website Software Engineer") {
        const role = SOFTWARE_ROLE_RE.exec(actual);
        expect(role).not.toBeNull();
        const prefix = actual.slice(0, role?.index ?? 0).trim();
        if (prefix) {
          expect(prefix).toMatch(/^[\p{L}\p{N}][\p{L}\p{N}\s&'\-+]*$/u);
        }
      }
    }
  });

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
    expect(result.persona).toBe('Veteran "CLI Software Engineer" expert');
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
        persona: 'Veteran "Bakery Software Engineer" expert',
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

  test("prompt requires a domain software engineer and rejects practitioner endings", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "Bakery Software Engineer" expert',
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
    expect(prompt).toContain("<Domain> Software Engineer");
    expect(prompt).toMatch(
      /software engineer who (?:specialises|specializes)/i,
    );
    expect(prompt).not.toContain("Coach, Lead");
  });

  test("prompt forbids descriptive task / domain phrases", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "Bakery Software Engineer" expert',
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
        persona: 'Veteran "Bakery Software Engineer" expert',
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
    expect(prompt).toContain('Veteran "Bakery Software Engineer" expert');
    expect(prompt).toContain(
      'Veteran "Fitness Coaching Software Engineer" expert',
    );
    expect(prompt).toContain('Veteran "Strength & Conditioning Coach" expert');
    expect(prompt).toContain('Veteran "Recipe Developer" expert');
    expect(prompt).toContain('Veteran "Academic Advisor" expert');
    expect(prompt).toContain(
      'Veteran "Recipe Platform Software Engineer" expert',
    );
    expect(prompt).toContain(
      'Veteran "Academic Advising Software Engineer" expert',
    );
    expect(prompt).toContain(
      'Veteran "Culinary recipe development and food science" expert',
    );
    expect(prompt).toContain(
      'Veteran "Higher-education academic planning" expert',
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
