// Copyright 2026 Nikolay Samokhvalov.

/**
 * Issue #101 — progress + heartbeat emitter for `samospec iterate`.
 *
 * `runIterate` used to run a round silently for 20+ minutes, then print
 * three lines at the end. This module centralizes the human-readable
 * progress output so operators can tell "working" from "hung":
 *
 *   - `round <N> starting`
 *   - `reviewer A (codex) starting`
 *   - `reviewer A complete (Xs, Y findings)`
 *   - `reviewer B (...) starting` / `... complete (...)`
 *   - `lead revise starting` / `lead revise complete (Xs)`
 *   - Heartbeat every ~30s of silent work, e.g.
 *     `lead (claude-opus-4-7) — 180s`
 *     (lists every currently-running child when more than one).
 *
 * All lines are emitted to the caller-supplied `emit()` sink, which
 * `runIterate` routes to stderr. Stdout is never touched here — scripts
 * parsing the final summary lines on stdout must not break.
 *
 * Testability: the heartbeat loop uses an injectable `clock` +
 * `schedule` so unit tests can drive simulated time forward without
 * real setInterval / Date.now. Default production wiring calls
 * `setInterval` and `performance.now()`.
 */

export interface ProgressClock {
  /** Monotonic timestamp in milliseconds (real clock or stub). */
  now(): number;
}

export interface ProgressSchedulerHandle {
  cancel(): void;
}

export type ProgressScheduleFn = (
  cb: () => void,
  intervalMs: number,
) => ProgressSchedulerHandle;

/**
 * Optional injection surface for tests. Production callers can pass
 * `{}` (all defaults) or leave the field undefined in IterateInput.
 */
export interface ProgressOptions {
  readonly clock?: ProgressClock;
  readonly heartbeatIntervalMs?: number;
  readonly schedule?: ProgressScheduleFn;
}

export type ChildLabel = "lead" | "reviewer_a" | "reviewer_b";

/**
 * Snapshot of an active child — used both for heartbeat formatting and
 * for phase-complete formatting. Identity string appears verbatim in
 * progress lines, so keep it stable: `<role> (<identity>)`.
 */
interface ActiveChild {
  readonly label: ChildLabel;
  /** Display identity, e.g. "codex", "claude-opus-4-7". */
  readonly identity: string;
  /** Clock timestamp at start — used for elapsed-seconds in heartbeat. */
  readonly startedAtMs: number;
}

/**
 * Emit sink. `runIterate` routes every call to its progress stderr
 * buffer.
 */
export type EmitFn = (line: string) => void;

export interface ProgressReporter {
  /** `round N starting`. */
  roundStart(roundNumber: number): void;

  /**
   * Bracket a reviewer phase. The caller invokes `start()` before
   * issuing the critique call and `complete()` after the promise
   * resolves; the returned closures handle timing + heartbeat bookkeeping.
   */
  beginReviewer(
    seat: "reviewer_a" | "reviewer_b",
    identity: string,
  ): PhaseHandle<{ findings: number }>;

  /** Bracket the lead revise phase. */
  beginLead(identity: string): PhaseHandle<undefined>;

  /**
   * Tear down any active heartbeat interval. Safe to call even when
   * no children are active or the reporter is in quiet mode.
   */
  shutdown(): void;
}

export interface PhaseHandle<ExtraT> {
  /** Close the phase and emit the completion line. */
  complete(extra: ExtraT): void;
  /**
   * Close the phase without emitting a completion line (e.g. on
   * exception before the adapter's promise returned meaningful data).
   * The caller is responsible for surfacing the failure elsewhere.
   */
  abort(): void;
}

/**
 * Default heartbeat interval — SPEC language is "~30s of silent work".
 * Kept as a constant so both the default and the test-injected value
 * have a single canonical origin.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000 as const;

export function defaultClock(): ProgressClock {
  // Monotonic; wraps Bun / Node performance.now when available, else
  // Date.now (non-monotonic but fine for stdout emission granularity).
  return {
    now: () => {
      if (
        typeof performance !== "undefined" &&
        typeof performance.now === "function"
      ) {
        return performance.now();
      }
      return Date.now();
    },
  };
}

export function defaultSchedule(): ProgressScheduleFn {
  return (cb, intervalMs) => {
    const handle = setInterval(cb, intervalMs);
    // Bun / Node: unref so a stray interval never blocks process exit.
    if (typeof (handle as { unref?: () => void }).unref === "function") {
      (handle as { unref: () => void }).unref();
    }
    return {
      cancel: (): void => {
        clearInterval(handle);
      },
    };
  };
}

/**
 * Build a reporter. When `quiet` is true, every method is a no-op
 * and no timers are scheduled.
 */
export function createProgressReporter(args: {
  readonly emit: EmitFn;
  readonly quiet: boolean;
  readonly options?: ProgressOptions;
}): ProgressReporter {
  if (args.quiet) return NOOP_REPORTER;

  const clock = args.options?.clock ?? defaultClock();
  const schedule = args.options?.schedule ?? defaultSchedule();
  const intervalMs =
    args.options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  const active = new Map<ChildLabel, ActiveChild>();
  let heartbeat: ProgressSchedulerHandle | null = null;

  const startHeartbeat = (): void => {
    if (heartbeat !== null) return;
    heartbeat = schedule(() => {
      if (active.size === 0) return;
      const now = clock.now();
      // One heartbeat line per active child. Two children (reviewer A +
      // reviewer B in parallel) emit two lines per interval — readers
      // can tell at a glance which one is holding things up.
      for (const child of active.values()) {
        const elapsedSec = Math.floor((now - child.startedAtMs) / 1000);
        args.emit(
          `${formatLabel(child.label)} (${child.identity}) — ${String(elapsedSec)}s`,
        );
      }
    }, intervalMs);
  };

  const stopHeartbeatIfIdle = (): void => {
    if (active.size === 0 && heartbeat !== null) {
      heartbeat.cancel();
      heartbeat = null;
    }
  };

  const begin = (label: ChildLabel, identity: string): ActiveChild => {
    const child: ActiveChild = {
      label,
      identity,
      startedAtMs: clock.now(),
    };
    active.set(label, child);
    startHeartbeat();
    return child;
  };

  const end = (label: ChildLabel): ActiveChild | undefined => {
    const child = active.get(label);
    active.delete(label);
    stopHeartbeatIfIdle();
    return child;
  };

  return {
    roundStart(roundNumber: number): void {
      args.emit(`round ${String(roundNumber)} starting`);
    },

    beginReviewer(seat, identity) {
      const child = begin(seat, identity);
      const seatLetter = seat === "reviewer_a" ? "A" : "B";
      args.emit(`reviewer ${seatLetter} (${identity}) starting`);
      let closed = false;
      return {
        complete: ({ findings }) => {
          if (closed) return;
          closed = true;
          end(seat);
          const elapsed = Math.max(
            0,
            Math.round((clock.now() - child.startedAtMs) / 1000),
          );
          args.emit(
            `reviewer ${seatLetter} complete (${String(elapsed)}s, ${String(findings)} findings)`,
          );
        },
        abort: () => {
          if (closed) return;
          closed = true;
          end(seat);
        },
      };
    },

    beginLead(identity) {
      const child = begin("lead", identity);
      args.emit(`lead revise starting`);
      void child;
      let closed = false;
      return {
        complete: () => {
          if (closed) return;
          closed = true;
          const c = end("lead");
          const startAt = c?.startedAtMs ?? clock.now();
          const elapsed = Math.max(
            0,
            Math.round((clock.now() - startAt) / 1000),
          );
          args.emit(`lead revise complete (${String(elapsed)}s)`);
        },
        abort: () => {
          if (closed) return;
          closed = true;
          end("lead");
        },
      };
    },

    shutdown(): void {
      active.clear();
      if (heartbeat !== null) {
        heartbeat.cancel();
        heartbeat = null;
      }
    },
  };
}

const NOOP_REPORTER: ProgressReporter = {
  roundStart: () => undefined,
  beginReviewer: () => ({
    complete: () => undefined,
    abort: () => undefined,
  }),
  beginLead: () => ({
    complete: () => undefined,
    abort: () => undefined,
  }),
  shutdown: () => undefined,
};

function formatLabel(label: ChildLabel): string {
  switch (label) {
    case "lead":
      return "lead";
    case "reviewer_a":
      return "reviewer A";
    case "reviewer_b":
      return "reviewer B";
  }
}
