// Copyright 2026 Nikolay Samokhvalov.

// SPEC §5 Phase 2 + §7 lead persona wiring + §11 subscription-auth UX.
//
// Contract:
//   - proposePersona(input, adapter) asks the lead for a persona in the
//     canonical form `Veteran "<skill>" expert`.
//   - On schema violation, ONE repair retry (matching §7 adapter
//     semantics). Second failure throws PersonaTerminalError.
//   - User choice is one of: { accept } | { edit, skill } | { replace,
//     persona }.
//   - When subscriptionAuth=true, emits the SPEC §11 UX message via
//     onNotice BEFORE the lead call.
//   - When explain=true, the system prompt adds a plain-English
//     preamble (SPEC §4 secondary ICP).
//
// No lead_terminal state mutation happens here — the caller (new/resume)
// owns state.json; this module throws a typed error the caller routes.

import { z } from "zod";

import { preParseJson } from "../adapter/json-parse.ts";
import type { Adapter, AskInput, EffortLevel } from "../adapter/types.ts";

// SPEC §5 Phase 2 canonical form. Matches:
//   Veteran "<non-empty skill>" expert
// Skill allows any character except unescaped double quotes.
export const PERSONA_FORM_RE = /^Veteran "([^"]+)" expert$/;

export function formatPersonaString(skill: string): string {
  return `Veteran "${skill}" expert`;
}

export function extractSkill(persona: string): string | null {
  const m = PERSONA_FORM_RE.exec(persona);
  return m !== null ? (m[1] ?? null) : null;
}

// SPEC §11 UX copy printed before the first paid lead call under
// subscription-auth. Exported so `doctor` and tests can compare against
// the canonical string.
export const SUBSCRIPTION_AUTH_MESSAGE =
  "Claude adapter is in subscription-auth mode. Token cost is not " +
  "visible; wall-clock/iteration caps enforced instead.";

// ---------- LLM JSON schema ----------

const personaAskSchema = z
  .object({
    persona: z.string().min(1),
    rationale: z.string(),
  })
  .passthrough();

// ---------- public types ----------

export interface PersonaProposal {
  readonly persona: string;
  readonly skill: string;
  readonly rationale: string;
  /** Whether the user accepted / edited / replaced to arrive at this. */
  readonly accepted: boolean;
}

export type PersonaChoice =
  | { readonly kind: "accept" }
  | { readonly kind: "edit"; readonly skill: string }
  | { readonly kind: "replace"; readonly persona: string };

export interface ProposePersonaInput {
  readonly idea: string;
  readonly explain: boolean;
  readonly subscriptionAuth: boolean;
  readonly choice: PersonaChoice;
  /** Sink for surface messages (subscription-auth copy etc.). */
  readonly onNotice?: (line: string) => void;
  /** Effort override; defaults to `max`. */
  readonly effort?: EffortLevel;
  /** Timeout override in ms; defaults to 120_000 (AskInput default). */
  readonly timeoutMs?: number;
}

// ---------- errors ----------

export class PersonaTerminalError extends Error {
  public readonly reason: "schema_violation" | "adapter_error";
  public readonly detail: string;

  constructor(reason: "schema_violation" | "adapter_error", detail: string) {
    super(`persona lead_terminal: ${reason}: ${detail}`);
    this.name = "PersonaTerminalError";
    this.reason = reason;
    this.detail = detail;
  }
}

export class PersonaChoiceError extends Error {
  constructor(detail: string) {
    super(`persona choice invalid: ${detail}`);
    this.name = "PersonaChoiceError";
  }
}

// ---------- implementation ----------

function buildPersonaPrompt(input: { idea: string; explain: boolean }): string {
  const explainPreamble = input.explain
    ? "Use plain English for any user-facing copy. Avoid engineer-terse " +
      "jargon in prose fields. (Non-technical ICP.)\n\n"
    : "";
  return (
    explainPreamble +
    "You are the samospec lead. Given a rough idea, propose a single " +
    'expert persona in the EXACT form `Veteran "<skill>" expert`. ' +
    "Examples:\n" +
    '  - Veteran "CLI software engineer" expert\n' +
    '  - Veteran "distributed systems / SRE specialist" expert\n\n' +
    "Respond ONLY with a JSON object:\n" +
    '  { "persona": "Veteran \\"<skill>\\" expert", "rationale": "..." }\n' +
    "Do not wrap in code fences. The skill must be non-empty and must " +
    "not contain unescaped double quotes. One and only one persona.\n\n" +
    `Idea:\n${input.idea}\n`
  );
}

function buildRepairPrompt(original: string, badAnswer: string): string {
  return (
    "Your previous response did not match the required schema. Re-emit " +
    'ONLY a JSON object of shape { "persona": "Veteran \\"<skill>\\" ' +
    'expert", "rationale": "..." }. No prose, no code fences. The ' +
    '`persona` field MUST match the regex ^Veteran "[^"]+" expert$.\n\n' +
    "Previous invalid output was:\n" +
    badAnswer +
    "\n\nRe-attempt the original request:\n" +
    original
  );
}

function parsePersonaAnswer(raw: string): {
  persona: string;
  rationale: string;
} | null {
  const parsed = preParseJson(raw);
  if (!parsed.ok) return null;
  const validated = personaAskSchema.safeParse(parsed.value);
  if (!validated.success) return null;
  const { persona, rationale } = validated.data;
  if (!PERSONA_FORM_RE.test(persona)) return null;
  return { persona, rationale };
}

async function askForPersona(
  adapter: Adapter,
  prompt: string,
  effort: EffortLevel,
  timeoutMs: number,
): Promise<string> {
  const askInput: AskInput = {
    prompt,
    context: "",
    opts: { effort, timeout: timeoutMs },
  };
  let output;
  try {
    output = await adapter.ask(askInput);
  } catch (err) {
    throw new PersonaTerminalError(
      "adapter_error",
      err instanceof Error ? err.message : String(err),
    );
  }
  return output.answer;
}

/**
 * Propose + confirm a persona per SPEC §5 Phase 2.
 *
 * The `choice` field is a pre-resolved user decision — callers wire
 * interactive prompt UI around this function and pass the resolved
 * action. This keeps proposePersona deterministic and test-harnessable
 * without having to mock stdin/stdout.
 */
export async function proposePersona(
  input: ProposePersonaInput,
  adapter: Adapter,
): Promise<PersonaProposal> {
  const notice = input.onNotice ?? (() => undefined);

  // SPEC §11: subscription-auth surface message before first paid call.
  if (input.subscriptionAuth) {
    notice(SUBSCRIPTION_AUTH_MESSAGE);
  }

  const effort: EffortLevel = input.effort ?? "max";
  const timeoutMs = input.timeoutMs ?? 120_000;
  const prompt = buildPersonaPrompt({
    idea: input.idea,
    explain: input.explain,
  });

  // First attempt.
  const rawFirst = await askForPersona(adapter, prompt, effort, timeoutMs);
  let validated = parsePersonaAnswer(rawFirst);

  // One repair retry if the first attempt failed the schema.
  if (validated === null) {
    const repairPrompt = buildRepairPrompt(prompt, rawFirst);
    const rawSecond = await askForPersona(
      adapter,
      repairPrompt,
      effort,
      timeoutMs,
    );
    validated = parsePersonaAnswer(rawSecond);
  }

  if (validated === null) {
    throw new PersonaTerminalError(
      "schema_violation",
      "persona did not match schema after one repair retry",
    );
  }

  const rationale = validated.rationale;

  // Apply user choice.
  const applied = applyChoice(validated.persona, rationale, input.choice);
  return applied;
}

function applyChoice(
  proposedPersona: string,
  rationale: string,
  choice: PersonaChoice,
): PersonaProposal {
  switch (choice.kind) {
    case "accept": {
      const skill = extractSkill(proposedPersona);
      if (skill === null) {
        throw new PersonaTerminalError(
          "schema_violation",
          "proposed persona failed form match post-validation (impossible)",
        );
      }
      return {
        persona: proposedPersona,
        skill,
        rationale,
        accepted: true,
      };
    }
    case "edit": {
      if (choice.skill.trim().length === 0) {
        throw new PersonaChoiceError("edited skill must be non-empty");
      }
      if (choice.skill.includes('"')) {
        throw new PersonaChoiceError(
          "edited skill must not contain unescaped double quotes",
        );
      }
      const persona = formatPersonaString(choice.skill);
      return {
        persona,
        skill: choice.skill,
        rationale,
        accepted: true,
      };
    }
    case "replace": {
      const m = PERSONA_FORM_RE.exec(choice.persona);
      if (m === null) {
        throw new PersonaChoiceError(
          `replacement persona must match ` +
            `Veteran "<skill>" expert, got: ${choice.persona}`,
        );
      }
      const skill = m[1] ?? "";
      return {
        persona: choice.persona,
        skill,
        rationale,
        accepted: true,
      };
    }
  }
}
