// Copyright 2026 Nikolay Samokhvalov.

// Issue #114 — non-TTY automation helpers for `samospec new` and
// `samospec iterate`.
//
// Two public surfaces:
//
//   - loadAnswersFile(path): parse a `--answers-file <path>` JSON file.
//     Shape: `{ "answers": [string, string, string, string, string] }`
//     (exactly 5 entries — the SPEC §5 interview cap). Returns a tagged
//     union so the caller can surface the error verbatim above USAGE.
//
//   - buildNonInteractiveResolvers({ acceptPersona, answers }): a
//     `ChoiceResolvers` that NEVER touches readline / stdin. Persona
//     accepts the lead's proposal as-is; questions pull from the
//     supplied answers list in order, falling back to `decide for me`
//     (a canonical schema option from SPEC §5) when no answer is
//     supplied or the list is exhausted.
//
// Both surfaces are tested in isolation before the CLI wires them;
// see tests/cli/new-answers-file.test.ts and
// tests/cli/new-accept-persona.test.ts.

import { readFileSync } from "node:fs";

import type { ChoiceResolvers } from "./new.ts";

// ---------- answers-file loader ----------

/** Expected interview answer count (SPEC §5 Phase 4 hard cap). */
export const INTERVIEW_ANSWER_COUNT = 5 as const;

export type LoadAnswersResult =
  | { readonly ok: true; readonly answers: readonly string[] }
  | { readonly ok: false; readonly error: string };

/**
 * Parse a `--answers-file <path>` JSON file. The file must be:
 *   { "answers": [string, ...] }  // length === INTERVIEW_ANSWER_COUNT
 *
 * Line numbers are reported for malformed JSON where possible so the
 * user can jump straight to the offending row.
 */
export function loadAnswersFile(filePath: string): LoadAnswersResult {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `samospec new: --answers-file could not be read: ${filePath} (${reason})`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const line = extractLineNumber(raw, err);
    const lineHint =
      line !== null ? ` (line ${String(line)})` : " (line unknown)";
    return {
      ok: false,
      error: `samospec new: --answers-file has invalid JSON${lineHint}: ${msg}`,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error:
        "samospec new: --answers-file must be a JSON object with an `answers` array " +
        `(got ${Array.isArray(parsed) ? "array" : typeof parsed})`,
    };
  }
  const answersRaw = (parsed as Record<string, unknown>)["answers"];
  if (!Array.isArray(answersRaw)) {
    return {
      ok: false,
      error:
        "samospec new: --answers-file is missing `answers` array (expected " +
        `{ "answers": [string x${String(INTERVIEW_ANSWER_COUNT)}] })`,
    };
  }
  for (let i = 0; i < answersRaw.length; i += 1) {
    if (typeof answersRaw[i] !== "string") {
      return {
        ok: false,
        error: `samospec new: --answers-file[${String(i)}] is not a string (got ${typeof answersRaw[i]})`,
      };
    }
  }
  if (answersRaw.length !== INTERVIEW_ANSWER_COUNT) {
    return {
      ok: false,
      error:
        `samospec new: --answers-file must contain exactly ${String(INTERVIEW_ANSWER_COUNT)} ` +
        `answers (got ${String(answersRaw.length)})`,
    };
  }
  return { ok: true, answers: answersRaw as readonly string[] };
}

/**
 * Best-effort line extractor for JSON.parse errors. V8 messages look
 * like `... in JSON at position 42 (line 3 column 5)`; older runtimes
 * only carry the character offset. We handle both.
 */
function extractLineNumber(raw: string, err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  // V8 ≥ 20: "line 3 column 5".
  const lineMatch = /line (\d+)/i.exec(err.message);
  if (lineMatch !== null) {
    const n = Number.parseInt(lineMatch[1] ?? "", 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // V8 < 20 / Bun fallback: "position 42".
  const posMatch = /position (\d+)/i.exec(err.message);
  if (posMatch !== null) {
    const pos = Number.parseInt(posMatch[1] ?? "", 10);
    if (Number.isFinite(pos) && pos >= 0) {
      // Count newlines up to pos.
      const before = raw.slice(0, Math.min(pos, raw.length));
      const nl = before.split("\n").length; // line = count(\n) + 1
      return nl;
    }
  }
  return null;
}

// ---------- non-interactive resolvers ----------

export interface NonInteractiveResolverInput {
  /** `--accept-persona` / `--yes`: accept the lead's proposal as-is. */
  readonly acceptPersona: boolean;
  /**
   * Pre-loaded answer list. When undefined OR shorter than the question
   * count, remaining slots fall back to `"decide for me"` (a canonical
   * option the interview prompt always accepts).
   */
  readonly answers: readonly string[] | undefined;
}

/**
 * Build a `ChoiceResolvers` that NEVER calls readline. Safe for CI,
 * piped invocations, background tool-use.
 *
 * - persona: ignores the proposal-shape; always returns `accept`.
 * - question: consumes `answers` in order. If an answer matches one of
 *   the question's `options`, returns that; otherwise falls back to
 *   `"decide for me"` (always a valid interview escape hatch). When
 *   the answers list is exhausted, continues to return `"decide for me"`
 *   so the flow never stalls.
 */
export function buildNonInteractiveResolvers(
  input: NonInteractiveResolverInput,
): ChoiceResolvers {
  const answers = input.answers ?? [];
  let cursor = 0;
  return {
    persona: (_p) => {
      // `acceptPersona: false` here would be nonsensical — if we're in
      // non-interactive mode and did NOT opt in to accepting the
      // persona, the CLI should have aborted before building resolvers.
      // Treat this as accept for safety.
      void input.acceptPersona;
      return Promise.resolve({ kind: "accept" });
    },
    question: (q) => {
      const next = answers[cursor];
      cursor += 1;
      if (next === undefined) {
        return Promise.resolve({ choice: "decide for me" });
      }
      // If the provided answer matches an option, pass through;
      // otherwise treat as a `custom` answer (the interview schema
      // always accepts custom free-text).
      if (q.options.includes(next)) {
        return Promise.resolve({ choice: next });
      }
      return Promise.resolve({ choice: "custom", custom: next });
    },
  };
}
