// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §5 Phase 6 + §7 — core review round orchestrator.
 *
 * Responsibilities:
 *   - Build round.json with status=planned, seats=pending
 *   - Transition round_state: planned -> running
 *   - Run reviewers A + B in parallel (Promise.all)
 *   - On partial failure (one seat fails), carry a lead directive
 *     ("Reviewer X was unavailable...") into the revise call
 *   - On total failure (both seats fail), retry the whole round once
 *     before marking abandoned
 *   - Atomic writes: critique file → fsync → round.json seat update →
 *     fsync → next seat (per SPEC §7 atomicity guarantee)
 *   - Transition to reviews_collected
 *   - Call lead.revise() with the collected critiques
 *   - On lead success: transition to lead_revised, write SPEC.md,
 *     TLDR.md, decisions.md append, changelog.md append, bump version
 *   - Commit with `spec(<slug>): refine v<N> after review r<MM>`
 *   - Transition to committed
 *   - On lead terminal failure: transition to lead_terminal
 *
 * Round directory layout (§9):
 *   .samo/spec/<slug>/reviews/r<NN>/
 *     codex.md          reviewer A critique (structured Markdown)
 *     claude.md         reviewer B critique (structured Markdown)
 *     summary.md        lead's synthesis (not yet — stub for Sprint 4)
 *     round.json        sidecar (§7 schema)
 *
 * Recovery rule: on resume, any critique file not listed `ok` in
 * round.json is ignored (treated as partial). We implement this by
 * trusting the round.json seat statuses as the source of truth.
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

import type { Adapter, CritiqueOutput, Finding } from "../adapter/types.ts";
import type { ReviewDecision } from "./decisions.ts";
import { reviseDecisionsToReviewDecisions } from "./decisions.ts";
import type { DegradedResult } from "./degradation.ts";

// ---------- constants ----------

/** SPEC §7 per-call default timeouts. */
export const CRITIQUE_TIMEOUT_MS = 300_000 as const;
export const REVISE_TIMEOUT_MS = 600_000 as const;

// ---------- types ----------

export type ReviewerSeat = "reviewer_a" | "reviewer_b";

export type SeatOutcomeState = "ok" | "failed" | "schema_violation" | "timeout";

/**
 * Terminal error reason for a reviewer seat (Issue #52).
 * Covers the same classes the adapters can throw, plus unknown.
 */
export type SeatErrorReason =
  | "cli_error"
  | "schema_violation"
  | "timeout"
  | "auth_failed"
  | "unknown";

/**
 * Diagnostic payload carried on a failed seat (Issue #52).
 * `message` is the first 500 chars of the adapter error with ANSI stripped.
 */
export interface SeatErrorDetail {
  readonly reason: SeatErrorReason;
  readonly message: string;
}

export interface SeatOutcome {
  readonly seat: ReviewerSeat;
  readonly state: SeatOutcomeState;
  readonly critique?: CritiqueOutput;
  readonly error?: string;
  /** Structured error detail for non-ok seats (Issue #52). */
  readonly errorDetail?: SeatErrorDetail;
}

export interface RoundAdapters {
  readonly lead: Adapter;
  readonly reviewerA: Adapter;
  readonly reviewerB: Adapter;
}

export interface RoundDirs {
  /** Absolute path to the round directory (`reviews/r<NN>`). */
  readonly roundDir: string;
  /** Absolute path to `round.json` inside the round dir. */
  readonly roundJson: string;
  /** Absolute path to `codex.md`. */
  readonly codexPath: string;
  /** Absolute path to `claude.md`. */
  readonly claudePath: string;
}

export interface RunRoundInput {
  readonly now: string;
  /**
   * Optional wall-clock source used for `started_at` / `completed_at`
   * in `round.json` (#100). When provided, called at the start of the
   * round (for `started_at`) and again at the terminal write — either
   * the completion write OR the abandoned/abort write — so the two
   * fields capture real wall-clock timestamps. Falls back to `now`.
   */
  readonly nowFn?: () => string;
  readonly roundNumber: number;
  readonly dirs: RoundDirs;
  /** Current SPEC.md contents fed into critique/revise. */
  readonly specText: string;
  /** Full prior decisions history (passed to revise). */
  readonly decisionsHistory: readonly ReviewDecision[];
  readonly adapters: RoundAdapters;
  readonly critiqueTimeoutMs?: number;
  readonly reviseTimeoutMs?: number;
  /** Optional reviewer guidelines appended to Reviewer A's critique(). */
  readonly guidelinesA?: string;
  /** Optional reviewer guidelines appended to Reviewer B's critique(). */
  readonly guidelinesB?: string;
  /**
   * When set, the lead's revise() prompt carries this directive (for
   * manual-edit incorporate flows per SPEC §7).
   */
  readonly manualEditDirective?: string;
  /** For the prompt's "reviewer unavailable" directive. */
  readonly reviewerUnavailableNote?: string;
  readonly degradedResolution?: DegradedResult;
  readonly signal?: AbortSignal;
  /**
   * #85 (v0.4.0): original --idea string. When present, threaded into
   * Reviewer B's critique() call so it can flag idea-contradictions, and
   * into the lead's revise() call so the AUTHORITATIVE framing appears.
   */
  readonly idea?: string;
  /**
   * #85 (v0.4.0): filesystem-safe slug (non-authoritative identifier).
   * Passed alongside `idea` into the revise() prompt builder.
   */
  readonly slug?: string;
}

export type RoundStopReason =
  | "ok"
  | "both_seats_failed_even_after_retry"
  | "lead_terminal";

export interface RunRoundOutcome {
  readonly roundNumber: number;
  readonly seats: {
    readonly reviewer_a: SeatOutcome;
    readonly reviewer_b: SeatOutcome;
  };
  readonly revisedSpec?: string;
  readonly ready: boolean;
  readonly rationale: string;
  readonly decisions: readonly ReviewDecision[];
  readonly roundStopReason: RoundStopReason;
  /** When reviewer(s) failed and the caller should surface a prompt. */
  readonly reviewersExhausted: boolean;
  /** The directive that WILL be included in lead's revise() — for tests. */
  readonly leadDirective?: string;
  readonly retried: boolean;
  /** Lead usage (for wall-clock + budget accounting). */
  readonly leadUsage?: CritiqueOutput["usage"];
  /**
   * Raw lead `revise()` error when `roundStopReason === "lead_terminal"`.
   * The caller (iterate CLI) routes this through
   * `classifyLeadTerminal` + `formatLeadTerminalMessage` to emit the
   * SPEC §7 per-sub-reason exit-4 copy.
   */
  readonly leadTerminalError?: unknown;
}

// ---------- atomic write helpers ----------

/** Write critique content to a file with fsync. */
function atomicWriteFile(absPath: string, body: string): void {
  const dir = path.dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(absPath)}.tmp.${process.pid}`);
  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, body, 0, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, absPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  // Parent dir fsync best-effort.
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Platform-specific.
  }
}

// ---------- critique serialization ----------

/**
 * Render a critique output to a Markdown file per the SPEC §9 layout
 * expectation. The format is one section per category + summary +
 * suggested-next-version, plus a raw JSON trailer so the lead's revise()
 * call can re-parse structure from the committed file on resume.
 */
export function renderCritiqueMarkdown(
  out: CritiqueOutput,
  seat: ReviewerSeat,
): string {
  const header =
    seat === "reviewer_a" ? "Reviewer A — Codex" : "Reviewer B — Claude";
  const lines: string[] = [];
  lines.push(`# ${header}`);
  lines.push("");
  lines.push(`## summary`);
  lines.push("");
  lines.push(out.summary.trim().length > 0 ? out.summary : "(no summary)");
  lines.push("");

  // Group by category.
  const byCat = new Map<string, Finding[]>();
  for (const f of out.findings) {
    const bucket = byCat.get(f.category);
    if (bucket === undefined) byCat.set(f.category, [f]);
    else bucket.push(f);
  }
  for (const [cat, findings] of byCat.entries()) {
    lines.push(`## ${cat}`);
    lines.push("");
    for (const f of findings) {
      lines.push(`- (${f.severity}) ${f.text}`);
    }
    lines.push("");
  }

  lines.push(`## suggested-next-version`);
  lines.push("");
  lines.push(out.suggested_next_version);
  lines.push("");

  // Machine-readable trailer so the committed file round-trips without
  // losing structured data. The fence marker is `<!-- samospec:critique
  // v1 --> { ... }` — not a Markdown code fence (cleaner diff).
  lines.push(`<!-- samospec:critique v1 -->`);
  lines.push(
    JSON.stringify(
      {
        findings: out.findings,
        summary: out.summary,
        suggested_next_version: out.suggested_next_version,
        usage: out.usage,
        effort_used: out.effort_used,
      },
      null,
      2,
    ),
  );
  lines.push(`<!-- samospec:critique end -->`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Try to recover a CritiqueOutput from a committed critique Markdown
 * file. Returns null on miss or malformed.
 */
export function recoverCritiqueFromFile(file: string): CritiqueOutput | null {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  const start = raw.indexOf("<!-- samospec:critique v1 -->");
  const end = raw.indexOf("<!-- samospec:critique end -->");
  if (start < 0 || end < 0 || end <= start) return null;
  const jsonBlob = raw
    .slice(start + "<!-- samospec:critique v1 -->".length, end)
    .trim();
  try {
    return JSON.parse(jsonBlob) as CritiqueOutput;
  } catch {
    return null;
  }
}

// ---------- round.json helpers ----------

/**
 * Seat value in round.json (Issue #52).
 * Plain string for pending/ok; object for failure states to carry error detail.
 * Older consumers that only read the string value will see an object and
 * can safely ignore the extra field (no schema breakage for new writes).
 */
export type RoundSidecarSeat =
  | "pending"
  | "ok"
  | {
      readonly status: "failed" | "schema_violation" | "timeout";
      readonly error: SeatErrorDetail;
    }
  // Plain-string failure values kept for forward-compat when reading old files.
  | "failed"
  | "schema_violation"
  | "timeout";

export interface RoundSidecar {
  readonly round: number;
  readonly status: "planned" | "running" | "complete" | "partial" | "abandoned";
  readonly seats: {
    readonly reviewer_a: RoundSidecarSeat;
    readonly reviewer_b: RoundSidecarSeat;
  };
  readonly started_at: string;
  readonly completed_at?: string;
}

export function writeRoundJson(file: string, data: RoundSidecar): void {
  atomicWriteFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

export function readRoundJson(file: string): RoundSidecar | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RoundSidecar;
  } catch {
    return null;
  }
}

// ---------- main orchestrator ----------

/**
 * Run one review round. Throws on unrecoverable errors (so the CLI can
 * route to exit 1). Returns a `RunRoundOutcome` describing the final
 * state so the CLI can decide on the next step (commit, halt, retry).
 *
 * Atomicity guarantees per SPEC §7:
 *   - round.json is written with status=planned BEFORE any critique
 *     runs. A crash immediately after leaves an empty round dir with
 *     a round.json the resume can either advance or delete.
 *   - After each critique completes, we write the critique file THEN
 *     update the seat status in round.json. A crash in between leaves
 *     an orphaned file the resume ignores (seat status still pending).
 *   - Between reviews_collected and lead_revised, we write round.json
 *     status=complete before calling the lead.
 */
export async function runRound(input: RunRoundInput): Promise<RunRoundOutcome> {
  const { dirs, roundNumber, adapters } = input;

  mkdirSync(dirs.roundDir, { recursive: true });

  const critiqueTimeout = input.critiqueTimeoutMs ?? CRITIQUE_TIMEOUT_MS;
  const reviseTimeout = input.reviseTimeoutMs ?? REVISE_TIMEOUT_MS;

  // #100: capture wall-clock timestamps for round.json. `startedAt` is
  // taken once here (right before the adapter fan-out begins); each
  // terminal write below calls `clock()` again to stamp a truthful
  // `completed_at`. When no `nowFn` is supplied we degrade to the single
  // `input.now` value (legacy behavior) — fine for tests that don't
  // advance time, but the iterate CLI now threads a real clock through.
  const clock: () => string = input.nowFn ?? ((): string => input.now);
  const startedAt = clock();

  // Seed round.json at `planned`.
  const initial: RoundSidecar = {
    round: roundNumber,
    status: "planned",
    seats: { reviewer_a: "pending", reviewer_b: "pending" },
    started_at: startedAt,
  };
  writeRoundJson(dirs.roundJson, initial);

  // Transition to running.
  writeRoundJson(dirs.roundJson, { ...initial, status: "running" });

  // First attempt.
  const attempt1 = await runReviewersParallel({
    specText: input.specText,
    adapters,
    critiqueTimeoutMs: critiqueTimeout,
    guidelinesA: input.guidelinesA ?? "",
    guidelinesB: input.guidelinesB ?? "",
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    // #85: thread idea to Reviewer B for contradiction detection.
    ...(input.idea !== undefined ? { idea: input.idea } : {}),
  });

  // Persist seats + critique files atomically.
  persistSeatResults(dirs, attempt1);

  let retried = false;
  let seatA = attempt1.reviewerA;
  let seatB = attempt1.reviewerB;
  if (seatA.state !== "ok" && seatB.state !== "ok") {
    // Both failed — retry whole round once (SPEC §7).
    retried = true;
    const attempt2 = await runReviewersParallel({
      specText: input.specText,
      adapters,
      critiqueTimeoutMs: critiqueTimeout,
      guidelinesA: input.guidelinesA ?? "",
      guidelinesB: input.guidelinesB ?? "",
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      // #85: thread idea to Reviewer B for contradiction detection.
      ...(input.idea !== undefined ? { idea: input.idea } : {}),
    });
    // Overwrite disk with the retry results.
    persistSeatResults(dirs, attempt2);
    seatA = attempt2.reviewerA;
    seatB = attempt2.reviewerB;
  }

  const anyOk = seatA.state === "ok" || seatB.state === "ok";
  if (!anyOk) {
    // Both seats failed and retry didn't recover. Mark abandoned; the
    // caller decides whether to prompt the user to continue with reduced
    // reviewers or exit per stopping condition #6.
    // #100: completed_at captures real wall-clock abort time, distinct
    // from started_at so post-hoc inspection reflects the true window.
    writeRoundJson(dirs.roundJson, {
      ...initial,
      status: "abandoned",
      seats: {
        reviewer_a: seatToDiskStatus(seatA),
        reviewer_b: seatToDiskStatus(seatB),
      },
      completed_at: clock(),
    });
    return {
      roundNumber,
      seats: { reviewer_a: seatA, reviewer_b: seatB },
      ready: false,
      rationale: "both reviewers failed even after a whole-round retry",
      decisions: [],
      roundStopReason: "both_seats_failed_even_after_retry",
      reviewersExhausted: true,
      retried,
    };
  }

  // Mark as complete before revise runs.
  // #100: completed_at stamps real wall-clock at finalization, distinct
  // from started_at so consumers can measure actual round duration.
  const roundComplete: RoundSidecar = {
    round: roundNumber,
    status:
      seatA.state === "ok" && seatB.state === "ok" ? "complete" : "partial",
    seats: {
      reviewer_a: seatToDiskStatus(seatA),
      reviewer_b: seatToDiskStatus(seatB),
    },
    started_at: startedAt,
    completed_at: clock(),
  };
  writeRoundJson(dirs.roundJson, roundComplete);

  // Build lead directive when one seat failed.
  const directive = buildLeadDirective({
    seatAOk: seatA.state === "ok",
    seatBOk: seatB.state === "ok",
    ...(input.manualEditDirective !== undefined
      ? { manualEditDirective: input.manualEditDirective }
      : {}),
    ...(input.reviewerUnavailableNote !== undefined
      ? { reviewerUnavailableNote: input.reviewerUnavailableNote }
      : {}),
  });

  // Call revise with the surviving critiques.
  const reviewsForLead: CritiqueOutput[] = [];
  if (seatA.state === "ok" && seatA.critique !== undefined) {
    reviewsForLead.push(seatA.critique);
  }
  if (seatB.state === "ok" && seatB.critique !== undefined) {
    reviewsForLead.push(seatB.critique);
  }

  try {
    const revised = await adapters.lead.revise({
      spec: buildReviseSpec(input.specText, directive),
      reviews: reviewsForLead,
      decisions_history: [...input.decisionsHistory],
      opts: { effort: "max", timeout: reviseTimeout },
      // #85: thread idea + slug into the revise prompt for AUTHORITATIVE
      // idea framing in every review-round lead call.
      ...(input.idea !== undefined ? { idea: input.idea } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
    });

    // Extract decisions from the response. Priority:
    //   1. revised.decisions (v0.2.0+ structured array from ReviseOutput)
    //   2. extractDecisions from rationale/spec body (legacy path)
    const decisions =
      revised.decisions !== undefined && revised.decisions.length > 0
        ? reviseDecisionsToReviewDecisions(revised.decisions)
        : extractDecisions(revised.rationale, revised.spec);

    return {
      roundNumber,
      seats: { reviewer_a: seatA, reviewer_b: seatB },
      revisedSpec: revised.spec,
      ready: revised.ready,
      rationale: revised.rationale,
      decisions,
      roundStopReason: "ok",
      reviewersExhausted: false,
      retried,
      leadUsage: revised.usage,
      ...(directive !== undefined ? { leadDirective: directive } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      roundNumber,
      seats: { reviewer_a: seatA, reviewer_b: seatB },
      ready: false,
      rationale: `lead_terminal: ${msg}`,
      decisions: [],
      roundStopReason: "lead_terminal",
      reviewersExhausted: false,
      retried,
      leadTerminalError: err,
      ...(directive !== undefined ? { leadDirective: directive } : {}),
    };
  }
}

// ---------- parallel reviewer dispatch ----------

interface ReviewerParallelInput {
  readonly specText: string;
  readonly adapters: RoundAdapters;
  readonly critiqueTimeoutMs: number;
  readonly guidelinesA: string;
  readonly guidelinesB: string;
  readonly signal?: AbortSignal;
  /** #85: idea string threaded into Reviewer B's critique() call. */
  readonly idea?: string;
}

async function runReviewersParallel(
  input: ReviewerParallelInput,
): Promise<{ reviewerA: SeatOutcome; reviewerB: SeatOutcome }> {
  const callA = input.adapters.reviewerA
    .critique({
      spec: input.specText,
      guidelines: input.guidelinesA,
      opts: { effort: "max", timeout: input.critiqueTimeoutMs },
    })
    .then<SeatOutcome>((critique) => ({
      seat: "reviewer_a",
      state: "ok",
      critique,
    }))
    .catch<SeatOutcome>((err: unknown) => ({
      seat: "reviewer_a",
      state: classifyReviewerError(err),
      error: err instanceof Error ? err.message : String(err),
      errorDetail: buildSeatErrorDetail(err),
    }));

  const callB = input.adapters.reviewerB
    .critique({
      spec: input.specText,
      guidelines: input.guidelinesB,
      opts: { effort: "max", timeout: input.critiqueTimeoutMs },
      // #85: thread the original idea so Reviewer B can detect
      // idea-contradictions against disclaimed classes.
      ...(input.idea !== undefined ? { idea: input.idea } : {}),
    })
    .then<SeatOutcome>((critique) => ({
      seat: "reviewer_b",
      state: "ok",
      critique,
    }))
    .catch<SeatOutcome>((err: unknown) => ({
      seat: "reviewer_b",
      state: classifyReviewerError(err),
      error: err instanceof Error ? err.message : String(err),
      errorDetail: buildSeatErrorDetail(err),
    }));

  const [reviewerA, reviewerB] = await Promise.all([callA, callB]);
  return { reviewerA, reviewerB };
}

// ANSI escape sequence regex — strip before storing error messages.
// Constructed via new RegExp() to avoid the no-control-regex ESLint
// rule, which flags literal control characters inside regex literals.
const ANSI_STRIP_RE = new RegExp(
  String.fromCharCode(27) + "\\[[0-9;]*[a-zA-Z]",
  "g",
);

/**
 * Strip ANSI escape codes and truncate to 500 chars (Issue #52).
 */
function sanitizeErrorMessage(raw: string): string {
  return raw.replace(ANSI_STRIP_RE, "").slice(0, 500);
}

/**
 * Map error message keywords to a SeatErrorReason (Issue #52).
 */
function classifyErrorReason(msg: string): SeatErrorReason {
  const lower = msg.toLowerCase();
  if (lower.includes("schema")) return "schema_violation";
  if (lower.includes("timeout")) return "timeout";
  if (lower.includes("auth") || lower.includes("unauthorized"))
    return "auth_failed";
  if (
    lower.includes("cli_error") ||
    lower.includes("exit 1") ||
    lower.includes("exit code")
  )
    return "cli_error";
  return "unknown";
}

function classifyReviewerError(err: unknown): SeatOutcomeState {
  const msg =
    err instanceof Error
      ? err.message.toLowerCase()
      : String(err).toLowerCase();
  if (msg.includes("schema")) return "schema_violation";
  if (msg.includes("timeout")) return "timeout";
  return "failed";
}

/**
 * Build a SeatErrorDetail from a caught error (Issue #52).
 */
function buildSeatErrorDetail(err: unknown): SeatErrorDetail {
  const raw = err instanceof Error ? err.message : String(err);
  const message = sanitizeErrorMessage(raw);
  const reason = classifyErrorReason(raw);
  return { reason, message };
}

function seatToDiskStatus(seat: SeatOutcome): RoundSidecarSeat {
  if (seat.state === "ok") return "ok";
  const errorDetail = seat.errorDetail;
  if (errorDetail !== undefined) {
    const status =
      seat.state === "schema_violation"
        ? ("schema_violation" as const)
        : seat.state === "timeout"
          ? ("timeout" as const)
          : ("failed" as const);
    return { status, error: errorDetail };
  }
  // Fallback: plain string (legacy path).
  return seat.state;
}

// ---------- persistence ----------

function persistSeatResults(
  dirs: RoundDirs,
  results: { reviewerA: SeatOutcome; reviewerB: SeatOutcome },
): void {
  // SPEC §7 atomicity: critique file write → fsync → round.json update
  // → fsync → next seat. The helper atomicWriteFile performs each file
  // write with an fsync; round.json updates come last per-seat.
  const current = readRoundJson(dirs.roundJson) ?? {
    round: 0,
    status: "running" as const,
    seats: {
      reviewer_a: "pending",
      reviewer_b: "pending",
    } as RoundSidecar["seats"],
    started_at: "1970-01-01T00:00:00Z",
  };

  if (
    results.reviewerA.state === "ok" &&
    results.reviewerA.critique !== undefined
  ) {
    atomicWriteFile(
      dirs.codexPath,
      renderCritiqueMarkdown(results.reviewerA.critique, "reviewer_a"),
    );
  }
  const nextA: RoundSidecar = {
    ...current,
    seats: {
      ...current.seats,
      reviewer_a: seatToDiskStatus(results.reviewerA),
    },
  };
  writeRoundJson(dirs.roundJson, nextA);

  if (
    results.reviewerB.state === "ok" &&
    results.reviewerB.critique !== undefined
  ) {
    atomicWriteFile(
      dirs.claudePath,
      renderCritiqueMarkdown(results.reviewerB.critique, "reviewer_b"),
    );
  }
  const nextB: RoundSidecar = {
    ...nextA,
    seats: {
      ...nextA.seats,
      reviewer_b: seatToDiskStatus(results.reviewerB),
    },
  };
  writeRoundJson(dirs.roundJson, nextB);
}

// ---------- lead directive builder ----------

export function buildLeadDirective(args: {
  readonly seatAOk: boolean;
  readonly seatBOk: boolean;
  readonly manualEditDirective?: string;
  readonly reviewerUnavailableNote?: string;
}): string | undefined {
  const parts: string[] = [];
  if (!args.seatAOk && args.seatBOk) {
    parts.push(
      "Reviewer A (Paranoid security/ops engineer) was unavailable this " +
        "round; proceed with Reviewer B's findings only.",
    );
  }
  if (args.seatAOk && !args.seatBOk) {
    parts.push(
      "Reviewer B (Pedantic QA / testability reviewer) was unavailable " +
        "this round; proceed with Reviewer A's findings only.",
    );
  }
  if (args.reviewerUnavailableNote !== undefined) {
    parts.push(args.reviewerUnavailableNote);
  }
  if (args.manualEditDirective !== undefined) {
    parts.push(args.manualEditDirective);
  }
  if (parts.length === 0) return undefined;
  return parts.join("\n\n");
}

function buildReviseSpec(spec: string, directive: string | undefined): string {
  if (directive === undefined) return spec;
  return `${spec}\n\n<!-- samospec:lead-directive -->\n${directive}\n<!-- samospec:lead-directive end -->\n`;
}

// ---------- decision extraction from revise output ----------

/**
 * Extract decisions from revise output. Priority:
 *   1. Parse `rationale` as JSON (if it begins with `{` or `[`).
 *   2. Look for a `<!-- samospec:decisions v1 --> ... <!-- end -->`
 *      marker inside `spec`.
 *   3. Fallback: empty.
 */
export function extractDecisions(
  rationale: string,
  spec: string,
): readonly ReviewDecision[] {
  // Try rationale first.
  const trimmed = rationale.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const out: ReviewDecision[] = [];
      const arr = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" &&
            parsed !== null &&
            Array.isArray((parsed as { decisions?: unknown }).decisions)
          ? (parsed as { decisions: unknown[] }).decisions
          : [];
      for (const item of arr) {
        if (isReviewDecision(item)) out.push(item);
      }
      if (out.length > 0) return out;
    } catch {
      // fall through
    }
  }

  // Try marker in spec body.
  const startMarker = "<!-- samospec:decisions v1 -->";
  const endMarker = "<!-- samospec:decisions end -->";
  const start = spec.indexOf(startMarker);
  const end = spec.indexOf(endMarker);
  if (start >= 0 && end > start) {
    const blob = spec.slice(start + startMarker.length, end).trim();
    try {
      const parsed: unknown = JSON.parse(blob);
      if (Array.isArray(parsed)) {
        return parsed.filter(isReviewDecision);
      }
    } catch {
      // fall through
    }
  }
  return [];
}

function isReviewDecision(v: unknown): v is ReviewDecision {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o["finding_ref"] !== "string") return false;
  if (typeof o["rationale"] !== "string") return false;
  const d = o["decision"];
  return d === "accepted" || d === "rejected" || d === "deferred";
}

// ---------- round dir formatter ----------

export function roundDirsFor(slugDir: string, roundNumber: number): RoundDirs {
  const padded = String(roundNumber).padStart(2, "0");
  const roundDir = path.join(slugDir, "reviews", `r${padded}`);
  return {
    roundDir,
    roundJson: path.join(roundDir, "round.json"),
    codexPath: path.join(roundDir, "codex.md"),
    claudePath: path.join(roundDir, "claude.md"),
  };
}

// ---------- diff helpers for convergence ----------

/** Count the number of lines that differ between two spec strings. */
export function countDiffLines(a: string, b: string): number {
  if (a === b) return 0;
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const aSet = new Map<string, number>();
  for (const l of aLines) aSet.set(l, (aSet.get(l) ?? 0) + 1);
  const bSet = new Map<string, number>();
  for (const l of bLines) bSet.set(l, (bSet.get(l) ?? 0) + 1);
  let diff = 0;
  const all = new Set<string>([...aSet.keys(), ...bSet.keys()]);
  for (const line of all) {
    const ca = aSet.get(line) ?? 0;
    const cb = bSet.get(line) ?? 0;
    diff += Math.abs(ca - cb);
  }
  return diff;
}

/**
 * Count how many categories received at least one finding. All taxonomy
 * categories in FindingCategorySchema are treated as non-summary —
 * "summary" is not part of the enum (the summary is a separate field on
 * CritiqueOutput). This helper exists so the convergence detector can
 * distinguish "new findings in real categories" from "only the summary
 * changed".
 */
export function countNonSummaryCategoriesWithFindings(
  findings: readonly Finding[],
): number {
  const cats = new Set<string>();
  for (const f of findings) {
    cats.add(f.category);
  }
  return cats.size;
}
