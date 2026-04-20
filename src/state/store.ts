// Copyright 2026 Nikolay Samokhvalov.

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

import { stateSchema, type State } from "./types.ts";

export interface NewStateArgs {
  readonly slug: string;
  readonly now: string;
}

/**
 * Build a fresh state.json record for a new spec.
 * Starts in phase `detect`, round 0, `planned`, version `0.0.0`.
 */
export function newState(args: NewStateArgs): State {
  const fresh: State = {
    slug: args.slug,
    phase: "detect",
    round_index: 0,
    version: "0.0.0",
    persona: null,
    push_consent: null,
    calibration: null,
    remote_stale: false,
    coupled_fallback: false,
    head_sha: null,
    round_state: "planned",
    exit: null,
    created_at: args.now,
    updated_at: args.now,
  };
  return stateSchema.parse(fresh);
}

/**
 * Read state.json from disk. Returns `null` if the file is absent.
 * Throws a contextual Error if the file is present but malformed or
 * schema-invalid — callers surface that as exit 1 per SPEC §7.
 */
export function readState(file: string): State | null {
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(
      `state.json at ${file} could not be read: ${(err as Error).message}`,
      { cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `state.json at ${file} is not valid JSON: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const result = stateSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `state.json at ${file} failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Read state.json, throwing if missing. Useful on resume where absence
 * is itself a user error (exit 1: "no spec found").
 */
export function readStateOrThrow(file: string): State {
  const s = readState(file);
  if (s === null) {
    throw new Error(`state.json not found at ${file}`);
  }
  return s;
}

/**
 * Atomic write: validate → write to `.tmp.<pid>.<n>` sibling → fsync →
 * rename over the target → fsync the parent directory. A crash mid-write
 * leaves either the old file or nothing, never a half-written state.json.
 *
 * SPEC §7: "Read/write with atomic write (temp file + fsync + rename) so
 * a crash mid-write never corrupts state.json."
 */
export function writeState(file: string, state: State): void {
  const parsed = stateSchema.safeParse(state);
  if (!parsed.success) {
    throw new Error(
      `refusing to write invalid state to ${file}: ${parsed.error.message}`,
    );
  }
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });

  const tmp = path.join(dir, `.${path.basename(file)}.tmp.${process.pid}`);
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
    // Best-effort cleanup if rename failed; surface the original error.
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }

  // fsync the directory so the rename is durable across a crash.
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Some platforms (notably Windows) do not allow fsync on a dir fd.
    // The rename remains atomic — directory-fsync is a durability upgrade,
    // not a correctness requirement for the "never corrupt" guarantee.
  }
}
