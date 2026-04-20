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

function buildInterviewPrompt(input: {
  persona: string;
  explain: boolean;
}): string {
  const explainPreamble = input.explain
    ? "Use plain English for any user-facing copy. Avoid engineer-terse " +
      "jargon in prose fields. (Non-technical ICP.)\n\n"
    : "";
  return (
    explainPreamble +
    `You are the samospec lead, playing the persona: ${input.persona}. ` +
    "Propose up to FIVE (5) high-signal strategic questions that the " +
    "user must answer to produce a v0.1 spec. Fewer is fine; more than 5 " +
    "will be truncated by the tool. Each question has an `id` (slug), " +
    "`text` (one sentence), and `options` (2-6 concrete choices the " +
    "persona thinks are the most likely answers).\n\n" +
    "Respond ONLY with a JSON object:\n" +
    '  { "questions": [ { "id": "...", "text": "...", "options": ' +
    '["...", "..."] }, ... ] }\n' +
    "Do not wrap in code fences.\n"
  );
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

  const effort: EffortLevel = input.effort ?? "max";
  const timeoutMs = input.timeoutMs ?? 120_000;
  const prompt = buildInterviewPrompt({
    persona: input.persona,
    explain: input.explain,
  });

  const askInput: AskInput = {
    prompt,
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
  const leadQuestions = validated.data.questions.slice(
    0,
    INTERVIEW_MAX_QUESTIONS,
  );

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
