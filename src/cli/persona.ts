// Copyright 2026 Nikolay Samokhvalov.

// SPEC §5 Phase 2 + §7 lead persona wiring + §11 subscription-auth UX.
//
// Contract:
//   - proposePersona(input, adapter) asks the lead for a persona in the
//     canonical form `Veteran "<skill>" expert`.
//   - On schema, role, or generic-field violation, ONE repair retry (matching
//     §7 adapter semantics), then falls back to the first valid answer.
//   - Customer-facing rationale is cleaned of persona-title rule talk.
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
    "  - Use the title form `<Field> Software Engineer`; it must end " +
    "exactly with `Software Engineer`. Close variants such as Fitness Web " +
    "Developer are accepted, but prefer `<Field> Software Engineer`.\n" +
    "  - `<Field>` is 1–2 words naming the customer's field.\n" +
    "  - The `<Field>` in `<Field> Software Engineer` must name the " +
    "customer's own field as stated in the " +
    "idea: a personal training studio needs `Fitness Studio Software " +
    "Engineer`; a neighbourhood bakery needs `Bakery Software Engineer`.\n" +
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
    "(describes expertise, not a software-engineering title)\n" +
    '  - Veteran "Small Business Software Engineer" expert\n' +
    '  - Veteran "Local Business Software Engineer" expert\n' +
    '  - Veteran "Website Software Engineer" expert\n' +
    '  - Veteran "Brochure Site Software Engineer" expert\n' +
    '  - Veteran "Marketing Software Engineer" expert\n' +
    "    (these use generic fields and are wrong when the idea names the " +
    "customer's field)\n\n" +
    "`rationale` is shown to the customer. Write one or two plain " +
    "sentences explaining why this engineer suits THEIR business. Never " +
    "mention the title's format, word count, casing, noun phrase, required " +
    "shape, rules, prompt, JSON, or schema.\n" +
    'BAD rationale: "The title is a 4-word Title Case noun phrase matching ' +
    'the required shape."\n' +
    'GOOD rationale: "They understand fitness-studio workflows and can ' +
    'build a booking experience around your clients and trainers."\n\n' +
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
    "software-engineering variants such as Fitness Web Developer are " +
    "accepted. " +
    "The field must be the customer's actual field from the idea, not a " +
    "generic label such as Small Business, Local Business, Website, " +
    "Brochure Site, or Marketing.\n\n" +
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
export const GENERIC_PERSONA_FIELDS = [
  "small business",
  "local business",
  "business",
  "website",
  "web",
  "brochure site",
  "marketing site",
  "marketing",
  "general",
  "company",
] as const;
const GENERIC_PERSONA_FIELD_SET = new Set<string>(GENERIC_PERSONA_FIELDS);
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

function singularizeFieldWord(word: string): string {
  if (/[^aeiou]ies$/iu.test(word)) return `${word.slice(0, -3)}y`;
  if (/(?:s|x|z|ch|sh)es$/iu.test(word)) return word.slice(0, -2);
  if (/s$/iu.test(word) && !/ss$/iu.test(word)) return word.slice(0, -1);
  return word;
}

function normalizedFieldWords(text: string): string[] {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(
    singularizeFieldWord,
  );
}

function ideaNamesGenericField(idea: string, field: string): boolean {
  const ideaWords = normalizedFieldWords(idea);
  const fieldWords = normalizedFieldWords(field);
  if (fieldWords.length === 0) return false;
  return ideaWords.some((_, start) =>
    fieldWords.every((word, offset) => ideaWords[start + offset] === word),
  );
}

function hasGenericPersonaField(persona: string, idea: string): boolean {
  const skill = extractSkill(persona);
  if (skill === null) return false;
  const title = normalizePersonaSkill(skill);
  const role = SOFTWARE_ROLE_RE.exec(title);
  if (role?.index === undefined) return false;
  let prefix = title.slice(0, role.index).trim();
  const roleText = role[0].trim();
  prefix = prefix.replace(
    /^(?:(?:senior|lead|principal|staff|junior)(?:\s+|$))+/iu,
    "",
  );
  const rawField =
    prefix || roleText.replace(/\s+(?:engineer|developer)$/iu, "");
  const field = normalizedFieldWords(rawField).join(" ");
  return (
    GENERIC_PERSONA_FIELD_SET.has(field) &&
    !(field === "marketing" && ideaNamesGenericField(idea, field))
  );
}

const RATIONALE_RULE_TALK_RE =
  /(?:\btitle[ -]case\b|\bnoun[ -]phrase\b|\bperson-noun\b|\brequired shape\b|\brequired format\b|\bmatching the required\b|\b\d+-word\b[^.!?\n]{0,80}\btitle\b|\btitle\b[^.!?\n]{0,80}\b\d+-word\b|\bbusiness-card title\b|\bper the (?:rules|instructions|prompt)\b|\bthe prompt (?:asks|requires|says)\b|\bas (?:the )?(?:rules|instructions|prompt) require\b|\b(?:these|the above|my) instructions\b|\bjson (?:object|output|schema)\b|\bthe schema\b|\bends? (?:in|with) the (?:person-)?noun\b)/iu;
const TITLE_RE = /\btitle\b/iu;
const CONDITIONAL_RULE_TALK_RE =
  /(?:^as required,|\bas required\.$|\bper the guidelines\b)/iu;
const PROTECTED_PERIOD = "\uE000";

function rationaleSentences(text: string): string[] {
  let protectedText = text.replace(/(?<=\d)\.(?=\d)/gu, PROTECTED_PERIOD);
  protectedText = protectedText.replace(
    /\b(?:e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|Prof|Sr|Jr)\./giu,
    (match) => match.replace(/\./gu, PROTECTED_PERIOD),
  );
  protectedText = protectedText.replace(/\b(?:[A-Z]\.){2,}/gu, (match) =>
    match.replace(/\./gu, PROTECTED_PERIOD),
  );
  return protectedText
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.replaceAll(PROTECTED_PERIOD, "."));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function replaceOldTitle(
  sentence: string,
  guardedTitle: string,
  oldTitle?: string,
): string {
  if (
    !oldTitle ||
    oldTitle.localeCompare(guardedTitle, undefined, {
      sensitivity: "accent",
    }) === 0
  )
    return sentence;
  if (oldTitle.trim().split(/\s+/u).length < 2) return sentence;
  if (guardedTitle.toLocaleLowerCase().includes(oldTitle.toLocaleLowerCase()))
    return sentence;
  const escapedPhrase = oldTitle
    .trim()
    .split(/\s+/u)
    .map(escapeRegExp)
    .join("\\s+");
  const phrase = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapedPhrase}(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  return sentence.replace(phrase, guardedTitle);
}

function truncateRationale(text: string): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= 400) return text;
  const prefix = codePoints.slice(0, 399).join("");
  const boundary = prefix.search(/\s+\S*$/u);
  return `${(boundary > 0 ? prefix.slice(0, boundary) : prefix).trimEnd()}…`;
}

/** Remove internal persona-title rule talk before rationale reaches storage/UI. */
export function cleanPersonaRationale(
  text: string,
  guardedTitle: string,
  oldTitle?: string,
): string {
  const cappedText = text.slice(0, 2_000);
  const normalized = cappedText.trim().replace(/\s+/gu, " ");
  const sentences = normalized.length > 0 ? rationaleSentences(normalized) : [];
  const kept: string[] = [];
  for (const rawSentence of sentences) {
    let sentence = rawSentence.trim();
    if (!sentence || RATIONALE_RULE_TALK_RE.test(sentence)) continue;
    if (TITLE_RE.test(sentence) && CONDITIONAL_RULE_TALK_RE.test(sentence))
      continue;
    sentence = replaceOldTitle(sentence, guardedTitle, oldTitle);
    const candidate = [...kept, sentence].join(" ");
    if (kept.length >= 3) break;
    if (Array.from(candidate).length > 400) {
      if (kept.length === 0) kept.push(truncateRationale(sentence));
      break;
    }
    kept.push(sentence);
  }
  if (kept.length > 0) return kept.join(" ");
  const firstWord = /^[\p{L}]+/u.exec(guardedTitle)?.[0] ?? "";
  const isInitialism =
    firstWord.length > 1 && firstWord === firstWord.toLocaleUpperCase();
  const initialismNeedsAn =
    isInitialism && /^[AEFHILMNORSX]$/u.test(firstWord[0] ?? "");
  const startsWithYouSound =
    !isInitialism && /^u[bcdfghjklmnpqrstvwxyz][aeiou]/iu.test(firstWord);
  const article = isInitialism
    ? initialismNeedsAn
      ? "An"
      : "A"
    : /^[aeiou]/iu.test(firstWord) && !startsWithYouSound
      ? "An"
      : "A";
  return `${article} ${guardedTitle} who will plan and build this with you.`;
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
  let oldTitleForRationale: string | undefined;

  // One repair retry if the first attempt failed the schema or role rule.
  if (
    validated === null ||
    !isSoftwareEngineerPersona(validated.persona) ||
    hasGenericPersonaField(validated.persona, input.idea)
  ) {
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
      oldTitleForRationale = normalizePersonaSkill(firstValid.persona);
      validated = {
        ...firstValid,
        persona: coerceSoftwareEngineerPersona(firstValid.persona),
      };
      repairFailed = true;
    }
    if (!repairFailed) {
      validated = parsePersonaAnswer(rawSecond);
      if (validated === null && firstValid !== null) {
        oldTitleForRationale = normalizePersonaSkill(firstValid.persona);
        validated = {
          ...firstValid,
          persona: coerceSoftwareEngineerPersona(firstValid.persona),
        };
      } else if (
        validated !== null &&
        (!isSoftwareEngineerPersona(validated.persona) ||
          hasGenericPersonaField(validated.persona, input.idea))
      ) {
        const fallback = firstValid ?? validated;
        oldTitleForRationale = normalizePersonaSkill(fallback.persona);
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

  const title = extractSkill(validated.persona) ?? FALLBACK_PERSONA_SKILL;
  const rationale = cleanPersonaRationale(
    validated.rationale,
    title,
    oldTitleForRationale,
  );

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
