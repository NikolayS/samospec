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
  cleanPersonaRationale,
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
  test("prompt explains customer-facing rationale and field-specific titles", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "Bakery Software Engineer" expert',
        rationale: "They understand bakery operations and can build the site.",
      }),
    ]);
    await proposePersona(
      {
        idea: "a neighbourhood bakery website",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );

    const prompt = adapter.structuredAsks[0].prompt;
    expect(prompt).toContain("shown to the customer");
    expect(prompt).toContain("personal training studio");
    expect(prompt).toContain("Fitness Studio Software Engineer");
    expect(prompt).toContain("neighbourhood bakery");
    expect(prompt).toContain("Bakery Software Engineer");
    expect(prompt).toContain("BAD rationale");
    expect(prompt).toContain("GOOD rationale");
    expect(prompt).toContain("Fitness Web Developer");
    expect(prompt).not.toContain("such as Web Developer");
    for (const generic of [
      "Small Business",
      "Local Business",
      "Website",
      "Brochure Site",
      "Marketing",
    ]) {
      expect(prompt).toContain(generic);
    }
  });

  test("removes title-rule talk from the production rationale", () => {
    expect(
      cleanPersonaRationale(
        "They can translate a personal trainer's needs into a useful studio website. The title is a 4-word Title Case noun phrase ending in the person-noun 'Developer', matching the required shape.",
        "Small Business Web Developer",
      ),
    ).toBe(
      "They can translate a personal trainer's needs into a useful studio website.",
    );
  });

  const rationaleTitle = "Small Business Web Software Engineer";

  test.each([
    "It uses Title Case.",
    "It uses Title-Case.",
    "It is a noun phrase.",
    "It is a noun-phrase.",
    "Developer is the person-noun.",
    "This has the required shape.",
    "This follows the required format.",
    "This is matching the required wording.",
    "It is a 4-word title.",
    "It ends in the noun Developer.",
    "It ends with the person-noun Developer.",
    "This is the business-card title.",
    "This is per the rules.",
    "This is per the instructions.",
    "This is per the prompt.",
    "This is matching the required title.",
    "Return a JSON object.",
    "Use the JSON schema.",
    "The schema defines the required title.",
    "The prompt asks for this.",
    "The prompt requires this.",
    "The prompt says this.",
    "As the rules require, it is concise.",
    "As instructions require, it is concise.",
    "These instructions demand it.",
    "The above instructions demand it.",
    "My instructions demand it.",
    "This title is concise, as required.",
    "This title is concise per the guidelines.",
  ])("drops rationale rule-talk trigger %j", (ruleTalk) => {
    expect(
      cleanPersonaRationale(
        `Useful domain context. ${ruleTalk} More useful context.`,
        rationaleTitle,
      ),
    ).toBe("Useful domain context. More useful context.");
  });

  test.each(["", "   \n\t "])(
    "uses a neutral rationale fallback for %j",
    (text) => {
      expect(cleanPersonaRationale(text, rationaleTitle)).toBe(
        `A ${rationaleTitle} who will plan and build this with you.`,
      );
    },
  );

  test.each([
    ["Artisan Bakery Software Engineer", "An"],
    ["Enterprise Software Engineer", "An"],
    ["Online Shop Software Engineer", "An"],
    ["ICU Software Engineer", "An"],
    ["FBI Software Engineer", "An"],
    ["UX Software Engineer", "A"],
    ["UI Software Engineer", "A"],
    ["Unicorn Software Engineer", "A"],
    ["User Research Software Engineer", "A"],
    ["Fitness Software Engineer", "A"],
  ])("uses %s's correct fallback article", (title, article) => {
    expect(cleanPersonaRationale("", title)).toBe(
      `${article} ${title} who will plan and build this with you.`,
    );
  });

  test("drops an 'As required,' title sentence", () => {
    expect(
      cleanPersonaRationale(
        "Useful context. As required, the title describes a software engineer. More context.",
        rationaleTitle,
      ),
    ).toBe("Useful context. More context.");
  });

  test("leaves a normal two-sentence rationale unchanged", () => {
    const text =
      "They understand local service businesses. They can build an accessible booking journey.";
    expect(cleanPersonaRationale(text, rationaleTitle)).toBe(text);
  });

  test.each([
    "They prompt replies to reservation requests and keep guests informed.",
    "They write care instructions pages for every service.",
    "They consume a JSON feed of listings from the property system.",
    "They designed the data schema for a booking app.",
    "They retain consent records as required by GDPR.",
    "They respond promptly when a customer needs help.",
    "They turn schematic drawings into accessible product pages.",
    "Their instructions for editors make publishing safer.",
    "The prompt replies shown in the inbox reduce response time.",
    "A JSON feed keeps availability synchronized across channels.",
    "A schema migration preserves existing reservation data.",
    "Updates are recorded as required by the regulator.",
  ])("preserves legitimate rationale language: %s", (text) => {
    expect(cleanPersonaRationale(text, rationaleTitle)).toBe(text);
  });

  test("replaces an old title after the persona guard rewrites it", () => {
    expect(
      cleanPersonaRationale(
        "A Bakery Owner understands this market.",
        "Bakery Software Engineer",
        "Bakery Owner",
      ),
    ).toBe("A Bakery Software Engineer understands this market.");
  });

  test("replaces only a whole old-title phrase, case-insensitively", () => {
    expect(
      cleanPersonaRationale(
        "A bakery owner understands this market.",
        "Bakery Software Engineer",
        "Bakery Owner",
      ),
    ).toBe("A Bakery Software Engineer understands this market.");
    expect(
      cleanPersonaRationale(
        "Coaching clients need clear plans.",
        "Fitness Software Engineering",
        "Coaching",
      ),
    ).toBe("Coaching clients need clear plans.");
    expect(
      cleanPersonaRationale(
        "Coaching clients need clear plans.",
        "Fitness Software Engineering",
        "Coaching clients",
      ),
    ).toBe("Fitness Software Engineering need clear plans.");
  });

  test("does not replace a short common title or one contained in the new title", () => {
    expect(
      cleanPersonaRationale(
        "Owners need simple reports.",
        "Website Software Engineers",
        "Owner",
      ),
    ).toBe("Owners need simple reports.");
    const text = "Bakery teams need online ordering.";
    expect(
      cleanPersonaRationale(text, "Bakery Software Engineer", "Bakery"),
    ).toBe(text);
    expect(
      cleanPersonaRationale(
        "A Bakery Software Engineer understands ordering.",
        "Bakery Software Engineer",
        "Bakery Owner",
      ),
    ).toBe("A Bakery Software Engineer understands ordering.");
  });

  test("rationale cleaning is idempotent", () => {
    const once = cleanPersonaRationale(
      "Strong fit. The title is a 3-word noun phrase. Practical delivery experience.",
      rationaleTitle,
    );
    expect(cleanPersonaRationale(once, rationaleTitle)).toBe(once);
  });

  test("caps rationale at three sentences and 400 code points", () => {
    expect(
      cleanPersonaRationale("One. Two. Three. Four.", rationaleTitle),
    ).toBe("One. Two. Three.");
    const long = `${"a".repeat(390)}. Too long to fit inside the limit.`;
    expect(cleanPersonaRationale(long, rationaleTitle)).toBe(
      `${"a".repeat(390)}.`,
    );
  });

  test("does not split rationale at abbreviations or decimals", () => {
    const text =
      "Dr. Lee builds U.S. booking tools, e.g. for salons, i.e. appointment-led businesses. They support version 2.5 vs. older systems. Mr. Khan validates delivery.";
    expect(cleanPersonaRationale(text, rationaleTitle)).toBe(text);
  });

  test("truncates overlong rationale text with an ellipsis", () => {
    const longSentence = `They understand ${"customer booking workflows ".repeat(25)}well.`;
    const result = cleanPersonaRationale(longSentence, rationaleTitle);
    expect(result.length).toBeLessThanOrEqual(400);
    expect(result.endsWith("…")).toBe(true);
    expect(result).not.toContain(`A ${rationaleTitle}`);

    const chinese = "他们了解预约流程和客户需求".repeat(40);
    const chineseResult = cleanPersonaRationale(chinese, rationaleTitle);
    expect(chineseResult.length).toBeLessThanOrEqual(400);
    expect(chineseResult.endsWith("…")).toBe(true);
  });

  test("does not split a surrogate pair when truncating rationale", () => {
    const result = cleanPersonaRationale(
      `Intro ${"😀".repeat(410)} trailing`,
      rationaleTitle,
    );
    expect(Array.from(result).length).toBeLessThanOrEqual(400);
    expect(result.endsWith("…")).toBe(true);
    expect(result).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });

  test("only treats conditional wording as rule talk when title is present", () => {
    const legitimate =
      "Records are retained as required. Changes are made per the guidelines.";
    expect(cleanPersonaRationale(legitimate, rationaleTitle)).toBe(legitimate);
  });

  test.each([
    "1-word ".repeat(28_572).slice(0, 200_000),
    "title ".repeat(33_334).slice(0, 200_000),
    "a".repeat(200_000),
  ])("handles 200 kB punctuation-free input in under 100 ms", (text) => {
    const started = performance.now();
    cleanPersonaRationale(text, rationaleTitle);
    expect(performance.now() - started).toBeLessThan(100);
  });

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
  test("a generic field gets exactly one repair and accepts a specific field", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "Small Business Web Developer" expert',
        rationale: "Builds websites for businesses.",
      }),
      JSON.stringify({
        persona: 'Veteran "Fitness Studio Software Engineer" expert',
        rationale: "They understand personal-training studio workflows.",
      }),
    ]);

    const result = await proposePersona(
      {
        idea: "a website for my personal-training studio",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );

    expect(result.skill).toBe("Fitness Studio Software Engineer");
    expect(adapter.structuredAsks).toHaveLength(2);
  });

  test.each([
    ["Senior Web Developer", "a fitness coaching app"],
    ["Senior Website Software Engineer", "a fitness coaching app"],
    ["Small-Business Software Engineer", "a fitness coaching app"],
    ["Small Businesses Software Engineer", "a fitness coaching app"],
  ])("repairs generic field variant %s", async (title, idea) => {
    const answer = JSON.stringify({
      persona: formatPersonaString(title),
      rationale: "r",
    });
    const adapter = makeScriptedStructuredAskAdapter([answer, answer]);
    await proposePersona(
      {
        idea,
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );
    expect(adapter.structuredAsks).toHaveLength(2);
  });

  test.each([
    ["a fitness coaching website", "Website Software Engineer", 2],
    [
      "a website for my small business, a personal training studio",
      "Small Business Web Developer",
      2,
    ],
    ["a web app for booking sessions at my gym", "Web Developer", 2],
    ["a brochure site for my bakery", "Brochure Site Software Engineer", 2],
    [
      "my company sells cakes; I need an online shop",
      "Company Software Engineer",
      2,
    ],
    ["a marketing agency website", "Marketing Software Engineer", 1],
    ["a fitness coaching website", "Marketing Software Engineer", 2],
  ])(
    "idea-aware generic field repair for %s with %s",
    async (idea, title, expectedCalls) => {
      const answer = JSON.stringify({
        persona: formatPersonaString(title),
        rationale: "r",
      });
      const adapter = makeScriptedStructuredAskAdapter([answer, answer]);
      await proposePersona(
        {
          idea,
          explain: false,
          subscriptionAuth: false,
          choice: { kind: "accept" },
        },
        adapter,
      );
      expect(adapter.structuredAsks).toHaveLength(expectedCalls);
    },
  );

  test("a bare Web Developer with a real idea costs one repair call", async () => {
    const answer = JSON.stringify({
      persona: 'Veteran "Web Developer" expert',
      rationale: "r",
    });
    const adapter = makeScriptedStructuredAskAdapter([answer, answer]);
    await proposePersona(
      {
        idea: "a fitness coaching app",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );
    expect(adapter.structuredAsks).toHaveLength(2);
  });

  test("a still-generic repair keeps the guarded result without a third call", async () => {
    const adapter = makeScriptedStructuredAskAdapter([
      JSON.stringify({
        persona: 'Veteran "Small Business Web Developer" expert',
        rationale: "First rationale.",
      }),
      JSON.stringify({
        persona: 'Veteran "Local Business Software Engineer" expert',
        rationale: "Repair rationale.",
      }),
    ]);

    const result = await proposePersona(
      {
        idea: "a website for my personal-training studio",
        explain: false,
        subscriptionAuth: false,
        choice: { kind: "accept" },
      },
      adapter,
    );

    expect(result.skill).toBe("Small Business Web Developer");
    expect(result.rationale).toBe("First rationale.");
    expect(adapter.structuredAsks).toHaveLength(2);
  });

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
    const cases = [
      ["Fitness Web Developer", "a fitness coaching app"],
      ["Bakery Full-Stack Developer", "a neighbourhood bakery website"],
      ["Fitness Front-End Engineer", "a fitness coaching app"],
      ["Bakery Backend Engineer", "a bakery ordering platform"],
      ["Fitness Mobile App Developer", "a fitness coaching app"],
      ["CLI Engineer", "a CLI tool for database backups"],
      ["Software Developer", "a fitness coaching app"],
      ["App Developer", "a fitness coaching app"],
    ] as const;
    for (const [title, idea] of cases) {
      const adapter = makeScriptedStructuredAskAdapter([
        JSON.stringify({ persona: formatPersonaString(title), rationale: "r" }),
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
    expect(prompt).toContain("<Field> Software Engineer");
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
