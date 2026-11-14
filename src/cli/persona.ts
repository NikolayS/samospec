// Copyright 2026 Nikolay Samokhvalov.

// SPEC §5 Phase 2 + §7 lead persona wiring + §11 subscription-auth UX.
//
// Contract:
//   - proposePersona(input, adapter) asks the lead for a persona in the
//     canonical form `Veteran "<skill>" expert`.
//   - On schema or role violation, ONE repair retry (matching §7 adapter
//     semantics). A second malformed answer is terminal only when the first
//     answer was malformed too; valid role violations are coerced.
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

import { UNIFIED_DEFAULT_EFFORT } from "../adapter/effort.ts";
import { preParseJson } from "../adapter/json-parse.ts";
import type {
  Adapter,
  EffortLevel,
  StructuredAskInput,
} from "../adapter/types.ts";

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
  /**
   * Effort for the lead's persona call. Resolved up in the CLI
   * (`--effort` flag > per-seat config > unified `high`) and threaded
   * down via the caller. Defaults to the unified `high` level when the
   * caller passes nothing (previously defaulted to `max`).
   */
  readonly effort?: EffortLevel;
  /** Timeout override in ms; defaults to 900_000 (15m, for slow max-effort models). */
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
  // The persona is the engineer writing the specification, not a
  // practitioner in the idea's domain. Tight shape constraints + a few
  // good/bad examples keep the lead from substituting a domain role.
  return (
    explainPreamble +
    "You are the samospec lead. Given a rough idea, propose a single " +
    'expert persona in the EXACT form `Veteran "<skill>" expert`.\n\n' +
    "SHAPE OF `<skill>` (strict):\n" +
    "  - 2–4 words, Title Case (punctuation such as & does not count " +
    "as a word).\n" +
    "  - The persona is ALWAYS a software engineer who specialises in " +
    "the idea's domain, never a practitioner in that domain.\n" +
    "  - Use the title form `<Domain> Software Engineer`; it must end " +
    "exactly with `Software Engineer`. Close variants such as Web " +
    "Developer are accepted, but prefer `<Domain> Software Engineer`.\n" +
    "  - `<Domain>` is 1–2 words naming the customer's field.\n" +
    "  - It is a job title / role label — what would be printed on this " +
    "engineer's business card. Answer the question 'What is this " +
    "person's title?', NOT 'What is their area of expertise?'.\n" +
    "  - NEVER a descriptive expertise / task / domain phrase.\n\n" +
    "GOOD examples (right shape):\n" +
    '  - Veteran "Bakery Software Engineer" expert\n' +
    '  - Veteran "Fitness Coaching Software Engineer" expert\n' +
    '  - Veteran "College Admissions Software Engineer" expert\n' +
    '  - Veteran "Postgres Backup Software Engineer" expert\n' +
    '  - Veteran "CLI Software Engineer" expert\n\n' +
    "BAD examples (wrong shape — do NOT emit these):\n" +
    '  - Veteran "Strength & Conditioning Coach" expert ' +
    '(use Veteran "Strength & Conditioning Software Engineer" expert)\n' +
    '  - Veteran "Recipe Developer" expert ' +
    '(use Veteran "Recipe Platform Software Engineer" expert)\n' +
    '  - Veteran "Academic Advisor" expert ' +
    '(use Veteran "Academic Advising Software Engineer" expert)\n' +
    '  - Veteran "Culinary recipe development and food science" ' +
    "expert (too long, describes a task not a person)\n" +
    '  - Veteran "Higher-education academic planning" expert ' +
    "(reads as a domain/task, not a title)\n" +
    '  - Veteran "Distributed systems and reliability" expert ' +
    "(describes expertise, not a software-engineering title)\n\n" +
    "Respond ONLY with a JSON object:\n" +
    '  { "persona": "Veteran \\"<skill>\\" expert", "rationale": "..." }\n' +
    "Do not wrap in code fences. The skill must be non-empty and must " +
    "not contain unescaped double quotes. One and only one persona.\n\n" +
    `Idea:\n${input.idea}\n`
  );
}

function buildRepairPrompt(
  original: string,
  badAnswer: string,
  practitionerRole: boolean,
): string {
  return (
    `Your previous response ${
      practitionerRole
        ? "described a practitioner, not a software engineer"
        : "did not match the required schema"
    }. Re-emit ` +
    'ONLY a JSON object of shape { "persona": "Veteran \\"<skill>\\" ' +
    'expert", "rationale": "..." }. No prose, no code fences. The ' +
    '`persona` field MUST match the regex ^Veteran "[^"]+" expert$.\n\n' +
    "The title must describe a software engineer who is an expert in the " +
    "customer's field, for example '<Field> Software Engineer'. Close " +
    "software-engineering variants such as Web Developer are accepted.\n\n" +
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

// Mirrors the SAMO Team app guard in persona-name.ts. This block and the app
// implementation must change together, including its regexes and word lists.
const MAX_PERSONA_DISPLAY_NAME_LENGTH = 60;
const FALLBACK_PERSONA_SKILL = "Website";
const GENERIC = "Website Software Engineer";
const ENGINEER_SUFFIX = "Software Engineer";
export const SOFTWARE_ROLE_RE =
  /(?:^|\s)(?:software|web|full[ -]?stack|front[ -]?end|back[ -]?end|mobile|app|cli|ios|android|game|data|devops|ml|machine learning)\s+(?:engineer|developer)$/iu;
export const PRACTITIONER_NOUNS = [
  "coach",
  "trainer",
  "instructor",
  "mentor",
  "therapist",
  "physiotherapist",
  "psychologist",
  "consultant",
  "chef",
  "cook",
  "baker",
  "barista",
  "stylist",
  "groomer",
  "teacher",
  "tutor",
  "educator",
  "lawyer",
  "attorney",
  "accountant",
  "doctor",
  "dentist",
  "veterinarian",
  "nurse",
  "agent",
  "realtor",
  "photographer",
  "videographer",
  "illustrator",
  "artist",
  "florist",
  "planner",
  "owner",
  "founder",
  "ceo",
  "cto",
  "officer",
  "manager",
  "director",
  "host",
  "receptionist",
  "contractor",
  "specialist",
  "expert",
  "strategist",
  "advisor",
  "adviser",
  "practitioner",
  "designer",
  "architect",
  "lead",
  "head",
  "professional",
  "guru",
  "coordinator",
  "operator",
  "technician",
  "analyst",
  "scientist",
  "athlete",
  "nutritionist",
  "chief",
  "sommelier",
  "broker",
  "pharmacist",
  "chiropractor",
  "electrician",
  "plumber",
  "mechanic",
  "carpenter",
  "tailor",
  "jeweler",
  "jeweller",
  "masseur",
  "masseuse",
  "barber",
  "hairdresser",
  "staff",
  "тренер",
  "entrenador",
  "entrenadora",
  "abogado",
  "abogada",
  "fisioterapeuta",
  "propietario",
  "propietaria",
] as const;
const PRACTITIONER_PATTERN = PRACTITIONER_NOUNS.join("|");
const PRACTITIONER_RE = new RegExp(
  `(?:^|[^\\p{L}\\p{N}_])(?:${PRACTITIONER_PATTERN})(?=$|[^\\p{L}\\p{N}_])`,
  "iu",
);
const TRAILING_PRACTITIONER_RE = new RegExp(
  `(?:^|\\s)(?:${PRACTITIONER_PATTERN})$`,
  "iu",
);
const CONNECTORS = new Set([
  "and",
  "or",
  "&",
  "of",
  "for",
  "the",
  "in",
  "to",
  "with",
  "at",
  "a",
  "an",
  "de",
  "del",
  "la",
  "el",
  "y",
  "i",
  "per",
  "para",
  "con",
  "amb",
  "по",
  "и",
  "в",
  "для",
]);
const TRAILING_CONNECTOR_RE =
  /(?:^|\s)(?:and|or|&|of|for|the|in|to|with|at|a|an|de|del|la|el|y|i|per|para|con|amb|по|и|в|для)$/iu;
const LEADING_CONNECTOR_RE =
  /^(?:(?:and|or|&|of|for|the|in|to|with|at|a|an|de|del|la|el|y|i|per|para|con|amb|по|и|в|для)\s+)+/iu;
const ALLOWED_DOMAIN_RE = /^[\p{L}\p{N}\s&'\-+]+$/u;

function cleanTitle(text: string): string {
  let cleaned = text.trim().replace(/\s+/gu, " ");
  cleaned = cleaned.replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "").trim();
  return cleaned.replace(/[\s,.;:!?…—-]+$/gu, "").trim();
}

function upperFirst(text: string): string {
  const [first = "", ...rest] = Array.from(text);
  return first.toLocaleUpperCase() + rest.join("");
}

function cleanDomain(text: string, maxWords: number): boolean {
  if (
    !text ||
    !ALLOWED_DOMAIN_RE.test(text) ||
    PRACTITIONER_RE.test(text) ||
    /['-]$/u.test(text)
  )
    return false;
  const tokens = text.split(/\s+/u);
  if (
    tokens.some((token) =>
      /^(?:software|engineer(?:s|ing)?|developer(?:s)?)$/iu.test(token),
    )
  )
    return false;
  if (
    CONNECTORS.has(tokens[0].toLocaleLowerCase()) ||
    CONNECTORS.has(tokens.at(-1)?.toLocaleLowerCase() ?? "")
  )
    return false;
  let words = 0;
  let previousConnector = false;
  for (const token of tokens) {
    const lower = token.toLocaleLowerCase();
    const connector = lower === "&" || lower === "and";
    if (CONNECTORS.has(lower) && !connector) return false;
    if (connector) {
      if (previousConnector) return false;
      previousConnector = true;
    } else {
      if (!/^[\p{L}\p{N}]/u.test(token)) return false;
      previousConnector = false;
      words += 1;
    }
  }
  return !previousConnector && words >= 1 && words <= maxWords;
}

function keepableRole(title: string): boolean {
  const match = SOFTWARE_ROLE_RE.exec(title);
  if (match?.index === undefined) return false;
  const prefix = title.slice(0, match.index).trim();
  const seniority =
    /^(?:(.+)\s+)?(?:senior|lead|principal|staff|junior)$/iu.exec(prefix);
  return (
    !prefix ||
    (seniority
      ? !seniority[1] || cleanDomain(seniority[1], 4)
      : cleanDomain(prefix, 4))
  );
}

function resultFor(domain: string, maxLength: number): string {
  const result = `${upperFirst(domain)} ${ENGINEER_SUFFIX}`;
  return result.length <= Math.min(maxLength, MAX_PERSONA_DISPLAY_NAME_LENGTH)
    ? result
    : GENERIC;
}

function practitionerDomain(title: string): string | undefined {
  let domain = title;
  let previous = "";
  let strippedPractitioner = false;
  while (domain !== previous) {
    previous = domain;
    const withoutPractitioner = domain
      .replace(TRAILING_PRACTITIONER_RE, "")
      .trim();
    if (withoutPractitioner !== domain) strippedPractitioner = true;
    domain = withoutPractitioner;
    domain = domain.replace(TRAILING_CONNECTOR_RE, "").trim();
  }
  if (!strippedPractitioner) return cleanDomain(domain, 3) ? domain : undefined;
  domain = domain.replace(LEADING_CONNECTOR_RE, "").trim();
  domain = domain.replace(/(?:^|\s)Software$/iu, "").trim();
  return cleanDomain(domain, 3) ? domain : undefined;
}

function normalizePersonaSkill(raw: string): string {
  const trimmed = raw.trim();
  const canonical = PERSONA_FORM_RE.exec(trimmed);
  return (
    cleanTitle((canonical ? canonical[1] : trimmed).replace(/"/gu, "'")) ||
    FALLBACK_PERSONA_SKILL
  );
}

function ensureEngineerTitle(
  title: string,
  maxLength = MAX_PERSONA_DISPLAY_NAME_LENGTH,
): string {
  const cleaned = cleanTitle(title);
  let result = GENERIC;
  if (
    cleaned.length <= MAX_PERSONA_DISPLAY_NAME_LENGTH &&
    keepableRole(cleaned)
  ) {
    result = upperFirst(cleaned).replace(
      /software\s+engineer$/iu,
      ENGINEER_SUFFIX,
    );
  } else {
    const engineerFirst = /^(.+?)\s+(?:for|in)\s+(.+)$/iu.exec(cleaned);
    if (
      engineerFirst &&
      keepableRole(engineerFirst[1]) &&
      cleanDomain(engineerFirst[2], 3)
    ) {
      result = resultFor(engineerFirst[2], maxLength);
    } else {
      const practitioner = practitionerDomain(cleaned);
      if (practitioner) result = resultFor(practitioner, maxLength);
      else {
        const leadingTitle =
          /^(?:head|director|manager|vp|chief)\s+of\s+(.+)$/iu.exec(cleaned);
        if (leadingTitle && cleanDomain(leadingTitle[1], 3))
          result = resultFor(leadingTitle[1], maxLength);
      }
    }
  }
  return result;
}

function isSoftwareEngineerPersona(persona: string): boolean {
  const skill = extractSkill(persona);
  if (skill === null) return false;
  const normalized = normalizePersonaSkill(skill);
  return ensureEngineerTitle(normalized) === normalized;
}

export function coerceSoftwareEngineerPersona(persona: string): string {
  return formatPersonaString(
    ensureEngineerTitle(normalizePersonaSkill(persona)),
  );
}

async function askForPersona(
  adapter: Adapter,
  prompt: string,
  effort: EffortLevel,
  timeoutMs: number,
): Promise<string> {
  // Use structuredAsk so the adapter does NOT inject an outer
  // { "answer": string } wrapper. buildPersonaPrompt already carries a
  // "Respond ONLY with { persona, rationale }" directive; adding a second
  // "Respond ONLY with { answer }" directive from buildAskPrompt creates a
  // schema conflict that causes non-deterministic parse failures.
  const askInput: StructuredAskInput = {
    prompt,
    context: "",
    opts: { effort, timeout: timeoutMs },
  };
  let output;
  try {
    output = await adapter.structuredAsk(askInput);
  } catch (err) {
    throw new PersonaTerminalError(
      "adapter_error",
      err instanceof Error ? err.message : String(err),
    );
  }
  return output.rawJson;
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

  const effort: EffortLevel = input.effort ?? UNIFIED_DEFAULT_EFFORT;
  const timeoutMs = input.timeoutMs ?? 900_000;
  const prompt = buildPersonaPrompt({
    idea: input.idea,
    explain: input.explain,
  });

  // First attempt.
  const rawFirst = await askForPersona(adapter, prompt, effort, timeoutMs);
  const firstValid = parsePersonaAnswer(rawFirst);
  let validated = firstValid;

  // One repair retry if the first attempt failed the schema or role rule.
  if (validated === null || !isSoftwareEngineerPersona(validated.persona)) {
    const repairPrompt = buildRepairPrompt(
      prompt,
      rawFirst,
      firstValid !== null,
    );
    let rawSecond = "";
    let repairFailed = false;
    try {
      rawSecond = await askForPersona(adapter, repairPrompt, effort, timeoutMs);
    } catch (error) {
      if (firstValid === null) throw error;
      validated = {
        ...firstValid,
        persona: coerceSoftwareEngineerPersona(firstValid.persona),
      };
      repairFailed = true;
    }
    if (!repairFailed) {
      validated = parsePersonaAnswer(rawSecond);
      if (validated === null && firstValid !== null) {
        validated = {
          ...firstValid,
          persona: coerceSoftwareEngineerPersona(firstValid.persona),
        };
      } else if (
        validated !== null &&
        !isSoftwareEngineerPersona(validated.persona)
      ) {
        const fallback = firstValid ?? validated;
        validated = {
          ...fallback,
          persona: coerceSoftwareEngineerPersona(fallback.persona),
        };
      }
    }
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
