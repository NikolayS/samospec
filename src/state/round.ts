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

import {
  roundSchema,
  type Round,
  type RoundState,
  type State,
} from "./types.ts";

/**
 * SPEC §7 round state transition table. Each key is a state; the value
 * is the set of permitted next states. `lead_terminal` has no outgoing
 * transitions — it is absorbing. `running -> running` is permitted to
 * model a retry-in-place when every seat has been kicked forward but
 * another retryable failure needs to be re-run inside the same state.
 *
 * Write ordering (per round, per critique) is documented in SPEC §7:
 *   critique file write -> fsync -> round.json seat update -> fsync.
 */
export const ROUND_TRANSITIONS: Record<RoundState, readonly RoundState[]> = {
  planned: ["running"],
  running: ["reviews_collected", "lead_terminal", "running"],
  reviews_collected: ["lead_revised", "lead_terminal"],
  lead_revised: ["committed", "lead_terminal"],
  committed: ["planned"],
  lead_terminal: [],
};

export class RoundTransitionError extends Error {
  public readonly from: RoundState;
  public readonly to: RoundState;
  constructor(from: RoundState, to: RoundState) {
    super(`illegal round-state transition: ${from} -> ${to}`);
    this.name = "RoundTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function isLegalRoundTransition(
  from: RoundState,
  to: RoundState,
): boolean {
  return ROUND_TRANSITIONS[from].includes(to);
}

export interface RoundTransitionOpts {
  readonly now: string;
}

/**
 * Apply a round-state transition to `state`, updating round_state,
 * round_index (on committed -> planned), and updated_at. Throws
 * RoundTransitionError on illegal moves; schema validation happens at
 * the writeState boundary.
 */
export function applyRoundTransition(
  state: State,
  to: RoundState,
  opts: RoundTransitionOpts,
): State {
  if (!isLegalRoundTransition(state.round_state, to)) {
    throw new RoundTransitionError(state.round_state, to);
  }
  const bumpsRound = state.round_state === "committed" && to === "planned";
  return {
    ...state,
    round_state: to,
    round_index: bumpsRound ? state.round_index + 1 : state.round_index,
    updated_at: opts.now,
  };
}

export interface NewRoundArgs {
  readonly round: number;
  readonly now: string;
}

/**
 * Build an initial `round.json` record for a new review round.
 * Status starts at `planned`; both reviewer seats are `pending`.
 */
export function newRound(args: NewRoundArgs): Round {
  return roundSchema.parse({
    round: args.round,
    status: "planned",
    seats: { reviewer_a: "pending", reviewer_b: "pending" },
    started_at: args.now,
  });
}

/**
 * Format the round directory name per SPEC §9 `reviews/rNN/`.
 * Rounds are 1-indexed and zero-padded to two digits. Higher numbers
 * are emitted unpadded (rare in practice — max rounds is small).
 */
export function roundDirFor(reviewsDir: string, round: number): string {
  const padded = round < 100 ? String(round).padStart(2, "0") : String(round);
  return path.join(reviewsDir, `r${padded}`);
}

/**
 * Read round.json. Returns null if absent, throws with file path on any
 * parse or schema failure so the caller can surface an exit-1 message.
 */
export function readRound(file: string): Round | null {
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(
      `round.json at ${file} could not be read: ${(err as Error).message}`,
      { cause: err },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `round.json at ${file} is not valid JSON: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const result = roundSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `round.json at ${file} failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Atomic write of round.json: validate -> .tmp -> fsync -> rename ->
 * fsync parent. Mirrors writeState; see SPEC §7 atomicity guarantee.
 */
export function writeRound(file: string, round: Round): void {
  const parsed = roundSchema.safeParse(round);
  if (!parsed.success) {
    throw new Error(
      `refusing to write invalid round to ${file}: ${parsed.error.message}`,
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
    // Platform-specific; rename is already atomic. See src/state/store.ts.
  }
}
