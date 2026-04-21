// Copyright 2026 Nikolay Samokhvalov.

/**
 * Issue #101 reviewer follow-up — heartbeat must not spam short
 * phases.
 *
 * The timer is aligned to `setInterval` boundaries, not to per-child
 * start times. Scenario:
 *   - Reviewer A starts and runs for 90s; heartbeats fire at 30s, 60s.
 *   - Reviewer A finishes at 90s. The global interval keeps ticking
 *     on the 30/60/90/... schedule.
 *   - Reviewer B starts at 88s — 2s before the next interval tick at
 *     90s. Under the old behaviour a heartbeat fires at 90s showing
 *     `reviewer B (...) — 2s`, then another at 120s showing `32s`, etc.
 *
 * SPEC says "every ~30s of silent work". A 2s heartbeat violates that
 * — so the first emission per child must be gated on its per-child
 * elapsed time >= intervalMs. Later emissions after the first should
 * still align with the global tick so two parallel children pair up
 * on the same tick boundary.
 */

import { describe, expect, test } from "bun:test";

import {
  createProgressReporter,
  type ProgressClock,
  type ProgressScheduleFn,
  type ProgressSchedulerHandle,
} from "../../src/cli/iterate-progress.ts";

interface StubClock extends ProgressClock {
  advance(ms: number): void;
}

interface StubScheduler {
  schedule: ProgressScheduleFn;
  /** Fire every active interval once, using the current clock time. */
  fireAll(): void;
}

function makeStubClockAndScheduler(): {
  clock: StubClock;
  scheduler: StubScheduler;
} {
  let nowMs = 0;
  interface Entry {
    cb: () => void;
    intervalMs: number;
    nextFireAt: number;
    cancelled: boolean;
  }
  const entries: Entry[] = [];

  const clock: StubClock = {
    now: () => nowMs,
    advance: (ms: number) => {
      const target = nowMs + ms;
      while (true) {
        const live = entries.filter((e) => !e.cancelled);
        if (live.length === 0) break;
        const next = live
          .map((e) => e.nextFireAt)
          .reduce((a, b) => (a < b ? a : b));
        if (next > target) break;
        nowMs = next;
        for (const e of entries) {
          if (!e.cancelled && e.nextFireAt === next) {
            e.cb();
            e.nextFireAt += e.intervalMs;
          }
        }
      }
      nowMs = target;
    },
  };

  const scheduler: StubScheduler = {
    schedule: (cb, intervalMs): ProgressSchedulerHandle => {
      const entry: Entry = {
        cb,
        intervalMs,
        nextFireAt: nowMs + intervalMs,
        cancelled: false,
      };
      entries.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
    fireAll: () => {
      clock.advance(0);
    },
  };

  return { clock, scheduler };
}

describe("createProgressReporter — per-child heartbeat gating (#101)", () => {
  test("does NOT emit heartbeat for a child whose elapsed < intervalMs", () => {
    const { clock, scheduler } = makeStubClockAndScheduler();
    const lines: string[] = [];
    const reporter = createProgressReporter({
      emit: (line) => lines.push(line),
      quiet: false,
      options: {
        clock,
        heartbeatIntervalMs: 30_000,
        schedule: scheduler.schedule,
      },
    });

    // Reviewer A runs 88s — heartbeats fire at 30s and 60s (not at 90s
    // because we stop 2s short of that tick). This establishes the
    // global 30/60/90/... interval cadence for the next assertion.
    const a = reporter.beginReviewer("reviewer_a", "codex");
    clock.advance(88_000);
    const heartbeatLinesAfterA = lines.filter((l) => /— \d+s$/.test(l));
    expect(heartbeatLinesAfterA).toEqual([
      "reviewer A (codex) — 30s",
      "reviewer A (codex) — 60s",
    ]);

    // Reviewer B starts at t=88s — 2s before the next global tick at
    // 90s. Under the buggy behaviour the 90s tick fires a heartbeat
    // for B at "2s". SPEC says "every ~30s of silent work", so the
    // first B heartbeat must NOT fire at elapsedForB < 30s.
    const b = reporter.beginReviewer("reviewer_b", "claude");
    clock.advance(2_000); // cross the 90s global tick boundary

    const afterBLines = lines.filter((l) =>
      /reviewer B \(claude\) — \d+s$/.test(l),
    );
    // B has been running 2s. Emitting "reviewer B (claude) — 2s" here
    // is the bug. The gate must suppress it.
    expect(afterBLines).toEqual([]);

    a.complete({ findings: 0 });
    b.complete({ findings: 0 });
    reporter.shutdown();
  });

  test("never emits a heartbeat for a child whose full phase is short", () => {
    const { clock, scheduler } = makeStubClockAndScheduler();
    const lines: string[] = [];
    const reporter = createProgressReporter({
      emit: (line) => lines.push(line),
      quiet: false,
      options: {
        clock,
        heartbeatIntervalMs: 30_000,
        schedule: scheduler.schedule,
      },
    });

    // Reviewer A runs 90s to establish the global interval cadence.
    const a = reporter.beginReviewer("reviewer_a", "codex");
    clock.advance(90_000);
    a.complete({ findings: 0 });

    // Start reviewer B at t=90s and let it run only 10s. The global
    // interval's next tick is at 120s — which would occur after B
    // completes at t=100s, so nothing to test there. Instead, start B
    // at t=88s (2s before a tick) to replicate the reviewer's exact
    // scenario. Adjust clock accordingly by rewinding the scenario.
    // We simulate "88s before next tick" by starting B at an offset.
    // Use a fresh reporter so intervals align predictably.
    const lines2: string[] = [];
    const { clock: clock2, scheduler: scheduler2 } =
      makeStubClockAndScheduler();
    const reporter2 = createProgressReporter({
      emit: (line) => lines2.push(line),
      quiet: false,
      options: {
        clock: clock2,
        heartbeatIntervalMs: 30_000,
        schedule: scheduler2.schedule,
      },
    });

    // Long-running lead establishes the global 30/60/90/... cadence.
    const lead = reporter2.beginLead("claude-opus-4-7");
    clock2.advance(88_000); // t=88s; two heartbeats already fired at 30s, 60s

    // Reviewer B starts 2s before the next global tick at 90s.
    const b = reporter2.beginReviewer("reviewer_b", "claude");
    clock2.advance(10_000); // advance to t=98s, CROSSING the 90s tick
    b.complete({ findings: 0 });

    const bHeartbeats = lines2.filter((l) =>
      /reviewer B \(claude\) — \d+s$/.test(l),
    );
    // B ran for 10s total, < 30s intervalMs. No heartbeat must have
    // fired for B. Under the old behaviour the 90s global tick would
    // have emitted "reviewer B (claude) — 2s".
    expect(bHeartbeats).toEqual([]);

    lead.complete(undefined);
    reporter2.shutdown();
  });
});
