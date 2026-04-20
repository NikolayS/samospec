// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §7/§9 — `context.json` provenance.
 *
 * Written once per phase under
 *   .samospec/spec/<slug>/context.json
 *
 * The schema is deliberately conservative:
 * - `files[]` records whether each discovered file was included,
 *   excluded (→ gist), or truncated.
 * - Top-level `risk_flags[]` is the union of per-file flags so the
 *   lead can see at a glance whether anything suspicious was fed in.
 * - `budget` records the phase, tokens used, and tokens budget.
 */

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

/** Canonical risk-flag vocabulary (SPEC §7). */
export const RISK_FLAGS = [
  "injection_pattern_detected",
  "high_entropy_strings_present",
  "large_file_truncated",
  "binary_excluded",
] as const;

export type RiskFlag = (typeof RISK_FLAGS)[number];

const riskFlagSchema = z.enum(RISK_FLAGS);

/** SPEC §5 phases; narrowed here to the ones context runs in. */
const contextPhaseSchema = z.enum([
  "interview",
  "draft",
  "revision",
  "review_loop",
]);

const fileEntrySchema = z
  .object({
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative().optional(),
    /** git blob SHA (40-char hex) — source of truth for cache keys. */
    blob: z
      .string()
      .regex(/^[0-9a-f]{40}$/i, "must be a 40-char hex SHA-1 digest"),
    included: z.boolean(),
    /** When excluded via budget, the gist_id is `<blob>.md`. */
    gist_id: z.string().min(1).optional(),
    risk_flags: z.array(riskFlagSchema),
  })
  .strict();

export type FileEntry = z.infer<typeof fileEntrySchema>;

const budgetSchema = z
  .object({
    phase: contextPhaseSchema,
    tokens_used: z.number().int().nonnegative(),
    tokens_budget: z.number().int().nonnegative(),
  })
  .strict();

export const contextJsonSchema = z
  .object({
    phase: contextPhaseSchema,
    files: z.array(fileEntrySchema),
    risk_flags: z.array(riskFlagSchema),
    budget: budgetSchema,
  })
  .strict();

export type ContextJson = z.infer<typeof contextJsonSchema>;

/**
 * Validate then atomically write `ctx` to `file`. Atomic in the same
 * sense as state/store.ts — temp file + fsync + rename + dir fsync.
 */
export function writeContextJson(file: string, ctx: ContextJson): void {
  const parsed = contextJsonSchema.safeParse(ctx);
  if (!parsed.success) {
    throw new Error(
      `refusing to write invalid context.json to ${file}: ` +
        `${parsed.error.message}`,
    );
  }
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });

  const tmp = path.join(dir, `.${path.basename(file)}.tmp.${String(process.pid)}`);
  const payload = `${JSON.stringify(parsed.data, null, 2)}\n`;

  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, payload, 0, "utf8");
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
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // dir-fsync not supported on all platforms (e.g., Windows).
  }
}

/**
 * Read and validate `context.json`. Returns `null` when the file is
 * absent. Throws a contextual Error when JSON is malformed or the
 * schema is violated.
 */
export function readContextJson(file: string): ContextJson | null {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `context.json at ${file} is not valid JSON: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const result = contextJsonSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `context.json at ${file} failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

/** Compute the absolute path for `.samospec/spec/<slug>/context.json`. */
export function contextJsonPath(repoPath: string, slug: string): string {
  return path.join(repoPath, ".samospec", "spec", slug, "context.json");
}
