// Copyright 2026 Nikolay Samokhvalov.

// SPEC §5 Phase 4 — 5-question strategic interview.
//
// Contract:
//   - runInterview(input, adapter) asks the lead for up to
//     INTERVIEW_MAX_QUESTIONS strategic questions about the idea,
//     each with options. Extras beyond 5 are DROPPED (hard cap).
//   - Every question is wrapped so its user-facing option list
//     ALWAYS includes the three universal escape hatches:
//     `decide for me`, `not sure — defer`, `custom`.
//   - The caller owns interactive prompt UI via `onQuestion`. The
//     callback resolves one of: { choice: "<option>" } or
//     { choice: "custom", custom: "<free text>" }.
//   - interview.json schema is zod-validated on both write and read.
//
// Scope guard: this module does NOT commit to git and does NOT move
// phase. The caller (new/resume) owns those seams.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { z } from "zod";

import { UNIFIED_DEFAULT_EFFORT } from "../adapter/effort.ts";
import { preParseJson } from "../adapter/json-parse.ts";
import type { Adapter, AskInput, EffortLevel } from "../adapter/types.ts";
import { PERSONA_FORM_RE } from "./persona.ts";

// ---------- constants ----------

export const INTERVIEW_MAX_QUESTIONS = 5 as const;

export const INTERVIEW_ESCAPE_HATCHES: readonly string[] = [
  "decide for me",
  "not sure — defer",
  "custom",
] as const;

const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

// ---------- zod schemas ----------

const QuestionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    options: z.array(z.string().min(1)),
  })
  .strict();

const AnswerSchema = z
  .object({
    id: z.string().min(1),
    choice: z.string().min(1),
    custom: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (a) => a.choice !== "custom" || typeof a.custom === "string",
    "choice=custom requires a non-empty `custom` free-text field",
  );

export const InterviewFileSchema = z
  .object({
    slug: z.string().min(1),
    persona: z.string().regex(PERSONA_FORM_RE),
    generated_at: z.string().regex(ISO_TS_RE),
    questions: z.array(QuestionSchema),
    answers: z.array(AnswerSchema),
  })
  .strict();

export type InterviewFile = z.infer<typeof InterviewFileSchema>;
export type InterviewQuestion = z.infer<typeof QuestionSchema>;
export type InterviewAnswer = z.infer<typeof AnswerSchema>;

// The shape the lead returns. `options` is optional so we tolerate
// bare-question responses (we always splice in escape hatches).
const LeadQuestionSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    options: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

const LeadResponseSchema = z
  .object({
    questions: z.array(LeadQuestionSchema),
  })
  .passthrough();

// ---------- public types ----------

export type OnQuestionCallback = (q: {
  readonly id: string;
  readonly text: string;
  readonly options: readonly string[];
}) => Promise<{
  readonly choice: string;
  readonly custom?: string;
}>;

export interface RunInterviewInput {
  readonly slug: string;
  readonly persona: string;
  readonly explain: boolean;
  readonly subscriptionAuth: boolean;
  readonly onQuestion: OnQuestionCallback;
  /** Sink for surface messages. */
  readonly onNotice?: (line: string) => void;
  /** Optional path for interview.json; nothing written when omitted. */
  readonly outputPath?: string;
  /** Override timestamp for deterministic tests; defaults to now(). */
  readonly now?: string;
  readonly effort?: EffortLevel;
  readonly timeoutMs?: number;
  /**
   * The user's raw idea/brief text. Used to detect whether a language
   * is specified so the prompt can include the appropriate guardrail.
   */
  readonly idea?: string;
}

export interface InterviewResult {
  readonly slug: string;
  readonly persona: string;
  readonly generated_at: string;
  readonly questions: readonly InterviewQuestion[];
  readonly answers: readonly InterviewAnswer[];
}

// ---------- errors ----------

export class InterviewTerminalError extends Error {
  constructor(detail: string) {
    super(`interview lead_terminal: ${detail}`);
    this.name = "InterviewTerminalError";
  }
}

// ---------- prompt builders ----------

/**
 * Returns true when the idea/brief does not specify a programming language
 * (or explicitly says the language is open/flexible/any). Used to decide
 * whether to inject the language-first guardrail into the prompt.
 */
export function ideaHasOpenLanguage(idea: string): boolean {
  // Explicit open-language signals.
  if (
    /language\s+(choice\s+)?(is\s+)?(open|flexible|any|tbd|undecided)/i.test(
      idea,
    )
  ) {
    return true;
  }
  if (/(open|flexible|any)\s+(language|tech\s+stack)/i.test(idea)) {
    return true;
  }
  // No specific language named -> treat as open.
  const LANG_RE =
    /\b(rust|python|go|golang|typescript|javascript|java|kotlin|swift|c\+\+|c#|ruby|elixir|haskell|scala|php|dart|zig)\b/i;
  return !LANG_RE.test(idea);
}

function buildInterviewPrompt(input: {
  persona: string;
  explain: boolean;
  idea?: string;
}): string {
  const explainPreamble = input.explain
    ? "Use plain English for any user-facing copy. Avoid engineer-terse " +
      "jargon in prose fields. (Non-technical ICP.)\n\n"
    : "";

  // Tech-stack guardrail (#NEW-INTERVIEW): the interview is about
  // PROJECT SUBSTANCE, not implementation tech. At most ONE question
  // total may concern the tech stack (language, database, framework,
  // hosting, etc.). When the brief already names a language, do not
  // re-open it. When it doesn't, you MAY ask one language question —
  // but only if it is genuinely strategic for this brief; otherwise
  // skip it and let the spec/engine choose later.
  const stackGuardrail =
    input.idea !== undefined
      ? ideaHasOpenLanguage(input.idea)
        ? "Tech-stack guardrail: the brief does not name a language. You " +
          "MAY include AT MOST ONE tech-stack question total (covering " +
          "language, database, framework, hosting, or similar) — and only " +
          "if it is genuinely strategic for this brief. Prefer skipping it " +
          "entirely; the spec/engine can choose downstream. Downstream " +
          "questions must not presuppose any specific language.\n\n"
        : "Tech-stack guardrail: the brief already names a language. Do " +
          "NOT re-open language choice. Across all questions, include AT " +
          "MOST ONE tech-stack question (language, database, framework, " +
          "hosting, or similar) — and only if it is genuinely strategic " +
          "for this brief.\n\n"
      : "Tech-stack guardrail: include AT MOST ONE tech-stack question " +
        "(language, database, framework, hosting, or similar) across all " +
        "questions, and only if it is genuinely strategic for this " +
        "brief.\n\n";

  return (
    explainPreamble +
    stackGuardrail +
    `You are the samospec lead, playing the persona: ${input.persona}. ` +
    "Propose up to FIVE (5) high-signal strategic questions that the " +
    "user must answer to produce a v0.1 spec. Fewer is fine; more than 5 " +
    "will be truncated by the tool.\n\n" +
    "Focus on PROJECT SUBSTANCE — questions a product owner cares about, " +
    "not implementation choices. Cover topics like: who the target users " +
    "are, what jobs they need done, the most important features for v0.1, " +
    "what success looks like, key edge cases or failure modes, " +
    "constraints (budget, timeline, compliance), and what's explicitly " +
    "out of scope. Avoid tech-stack questions beyond the one allowed by " +
    "the guardrail above.\n\n" +
    // samo.team #435: the lead was caught producing two questions with
    // identical text. Downstream the persona/spec pipeline hangs on the
    // duplicate. Distinctness must be explicit in the prompt; the
    // runInterview code-side dedupe is the second layer.
    "Every question must be DISTINCT. No question may be a duplicate or " +
    "paraphrase of any other question in this same set — each must " +
    "explore a different aspect of the user's idea (different topic, " +
    "different decision, different axis). Repeats are unacceptable.\n\n" +
    "Each question has an `id` (slug), `text` (one sentence), and " +
    "`options` (2-6 concrete choices the persona thinks are the most " +
    "likely answers).\n\n" +
    "Respond ONLY with a JSON object:\n" +
    '  { "questions": [ { "id": "...", "text": "...", "options": ' +
    '["...", "..."] }, ... ] }\n' +
    "Do not wrap in code fences.\n"
  );
}

/**
 * Stricter prompt issued as a retry when the first lead response
 * contained duplicate question text (samo.team #435). Names the offender
 * explicitly so the lead doesn't repeat the mistake.
 */
function buildDedupeRetryPrompt(input: {
  basePrompt: string;
  duplicateTexts: readonly string[];
}): string {
  const dups = input.duplicateTexts.map((t) => `  - "${t}"`).join("\n");
  return (
    "Your previous response contained DUPLICATE question text. The " +
    "following question text appeared more than once (case- and " +
    "whitespace-insensitive):\n" +
    `${dups}\n\n` +
    "Regenerate the full question set. Every question's text MUST be " +
    "distinct — no duplicates, no paraphrases, no whitespace- or " +
    "case-only variations. Each question explores a different aspect of " +
    "the idea. If you cannot produce N distinct questions, return fewer " +
    "questions rather than repeating.\n\n" +
    "Original instructions follow below, unchanged:\n\n" +
    input.basePrompt
  );
}

/**
 * Normalize question text for duplicate detection: trim, collapse
 * internal whitespace, lowercase. Catches whitespace-only and case-only
 * paraphrases that would otherwise hang the downstream persona.
 */
function normalizeQuestionText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Returns the duplicate normalized texts (one entry per offender, no
 * order guarantees) in the question list. Empty array means all
 * distinct.
 */
function findDuplicateTexts(
  questions: readonly { readonly text: string }[],
): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const q of questions) {
    const norm = normalizeQuestionText(q.text);
    if (seen.has(norm)) {
      dups.add(norm);
    } else {
      seen.add(norm);
    }
  }
  return [...dups];
}

// ---------- runInterview ----------

/**
 * SPEC §5 Phase 4 — ask the lead for up to 5 questions, then drive the
 * user through them. Extras past 5 are dropped (hard cap); fewer than 5
 * are proceed-with-fewer.
 *
 * The `onQuestion` callback is the UI seam — callers wire interactive
 * numbered-menu prompts around it. Tests pass a deterministic auto-
 * responder.
 */
export async function runInterview(
  input: RunInterviewInput,
  adapter: Adapter,
): Promise<InterviewResult> {
  if (!PERSONA_FORM_RE.test(input.persona)) {
    throw new InterviewTerminalError(
      `persona is not in canonical form: ${input.persona}`,
    );
  }

  const effort: EffortLevel = input.effort ?? UNIFIED_DEFAULT_EFFORT;
  const timeoutMs = input.timeoutMs ?? 900_000;
  const prompt = buildInterviewPrompt({
    persona: input.persona,
    explain: input.explain,
    ...(input.idea !== undefined ? { idea: input.idea } : {}),
  });

  // samo.team #435: ask the lead, dedupe-check the response, re-prompt
  // once with a stricter instruction if duplicates are detected. After
  // the retry we bail with InterviewTerminalError rather than handing a
  // malformed question set downstream (which previously hung the
  // persona/spec pipeline forever).
  const MAX_DEDUPE_RETRIES = 1;
  let leadQuestions: readonly z.infer<typeof LeadQuestionSchema>[] = [];
  let currentPrompt = prompt;
  let lastDuplicates: string[] = [];
  for (let attempt = 0; attempt <= MAX_DEDUPE_RETRIES; attempt += 1) {
    const askInput: AskInput = {
      prompt: currentPrompt,
      context: "",
      opts: { effort, timeout: timeoutMs },
    };
    let askOut;
    try {
      askOut = await adapter.ask(askInput);
    } catch (err) {
      throw new InterviewTerminalError(
        err instanceof Error ? err.message : String(err),
      );
    }

    const parsed = preParseJson(askOut.answer);
    if (!parsed.ok) {
      throw new InterviewTerminalError(
        `lead response was not valid JSON: ${parsed.error.message}`,
      );
    }
    const validated = LeadResponseSchema.safeParse(parsed.value);
    if (!validated.success) {
      throw new InterviewTerminalError(
        `lead response did not match schema: ${validated.error.message}`,
      );
    }

    // Hard cap at 5. Truncate extras silently; caller may log the drop.
    const capped = validated.data.questions.slice(0, INTERVIEW_MAX_QUESTIONS);
    const dups = findDuplicateTexts(capped);
    if (dups.length === 0) {
      leadQuestions = capped;
      break;
    }

    lastDuplicates = dups;
    if (attempt >= MAX_DEDUPE_RETRIES) {
      // Out of retries — fail fast rather than hand a duplicate-laden
      // question set to the downstream persona (where it would hang).
      throw new InterviewTerminalError(
        `lead returned duplicate question text after ${String(
          attempt + 1,
        )} attempt(s); refusing to proceed (would hang downstream). ` +
          `Duplicates (normalized): ${dups.map((d) => JSON.stringify(d)).join(", ")}`,
      );
    }

    if (input.onNotice) {
      input.onNotice(
        `interview: lead returned duplicate question text; re-prompting once.`,
      );
    }
    currentPrompt = buildDedupeRetryPrompt({
      basePrompt: prompt,
      duplicateTexts: dups,
    });
  }
  void lastDuplicates;

  // Compose each question with guaranteed escape hatches, preserving
  // whatever the lead returned first.
  const questions: InterviewQuestion[] = leadQuestions.map((q) => {
    const leadOptions = q.options ?? [];
    const composed: string[] = [];
    const seen = new Set<string>();
    for (const opt of leadOptions) {
      if (!seen.has(opt)) {
        composed.push(opt);
        seen.add(opt);
      }
    }
    for (const hatch of INTERVIEW_ESCAPE_HATCHES) {
      if (!seen.has(hatch)) {
        composed.push(hatch);
        seen.add(hatch);
      }
    }
    return {
      id: q.id,
      text: q.text,
      options: composed,
    };
  });

  const answers: InterviewAnswer[] = [];
  for (const q of questions) {
    const resp = await input.onQuestion({
      id: q.id,
      text: q.text,
      options: q.options,
    });
    if (resp.choice === "custom") {
      if (typeof resp.custom !== "string" || resp.custom.trim().length === 0) {
        throw new InterviewTerminalError(
          `answer to ${q.id} picked 'custom' but supplied no custom text`,
        );
      }
      answers.push({ id: q.id, choice: "custom", custom: resp.custom });
    } else {
      answers.push({ id: q.id, choice: resp.choice });
    }
  }

  const now = input.now ?? new Date().toISOString();
  const result: InterviewResult = {
    slug: input.slug,
    persona: input.persona,
    generated_at: now,
    questions,
    answers,
  };

  if (input.outputPath !== undefined) {
    writeInterview(input.outputPath, {
      slug: result.slug,
      persona: result.persona,
      generated_at: result.generated_at,
      questions: [...result.questions],
      answers: [...result.answers],
    });
  }

  return result;
}

// ---------- file I/O ----------

/**
 * Atomic write of interview.json — zod-validates the payload first, then
 * uses temp-file + fsync + rename for crash safety (matches
 * src/state/store.ts pattern).
 */
export function writeInterview(file: string, payload: InterviewFile): void {
  const validated = InterviewFileSchema.safeParse(payload);
  if (!validated.success) {
    throw new Error(
      `refusing to write invalid interview.json to ${file}: ${validated.error.message}`,
    );
  }
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });

  const tmp = path.join(dir, `.${path.basename(file)}.tmp.${process.pid}`);
  const json = `${JSON.stringify(validated.data, null, 2)}\n`;

  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, json, 0, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }

  // Best-effort directory fsync for durability.
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Some platforms do not allow fsync on a dir fd.
  }
}

/**
 * Read + validate interview.json. Returns null if the file is absent.
 * Throws a contextual Error if the file is present but malformed.
 */
export function readInterview(file: string): InterviewFile | null {
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(
      `interview.json at ${file} could not be read: ${(err as Error).message}`,
      { cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `interview.json at ${file} is not valid JSON: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const result = InterviewFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `interview.json at ${file} failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}
