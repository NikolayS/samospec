// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import {
  runWithCappedRetry,
  computeAttemptTimeouts,
} from "../../src/adapter/timeout.ts";

describe("computeAttemptTimeouts (SPEC §7 capped retry)", () => {
  test("returns exactly three attempts: base, +50%, base", () => {
    const attempts = computeAttemptTimeouts(120_000);

    expect(attempts).toEqual([120_000, 180_000, 120_000]);
  });

  test("+50% is rounded deterministically for odd base", () => {
    const attempts = computeAttemptTimeouts(100);

    expect(attempts).toEqual([100, 150, 100]);
  });

  test("never exceeds 3.5x the base in total", () => {
    const base = 600_000;
    const attempts = computeAttemptTimeouts(base);
    const total = attempts.reduce((a, b) => a + b, 0);

    expect(total).toBeLessThanOrEqual(Math.ceil(base * 3.5));
    expect(total).toBe(base + Math.floor(base * 1.5) + base);
  });

  test("rejects non-positive base timeouts", () => {
    expect(() => computeAttemptTimeouts(0)).toThrow();
    expect(() => computeAttemptTimeouts(-1)).toThrow();
    expect(() => computeAttemptTimeouts(NaN)).toThrow();
  });
});

describe("runWithCappedRetry (SPEC §7)", () => {
  test("first attempt succeeds: returns result, no retries", async () => {
    const calls: number[] = [];
    const result = await runWithCappedRetry(
      ({ timeout, attempt }) => {
        calls.push(timeout);
        expect(attempt).toBe(0);
        return Promise.resolve({ ok: true as const, value: "fine" });
      },
      { baseTimeoutMs: 100 },
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual([100]);
  });

  test("timeout -> +50% retry succeeds: two attempts", async () => {
    const calls: number[] = [];
    const result = await runWithCappedRetry(
      ({ timeout, attempt }) => {
        calls.push(timeout);
        if (attempt === 0) {
          return Promise.resolve({
            ok: false as const,
            reason: "timeout" as const,
          });
        }
        return Promise.resolve({ ok: true as const, value: "fine" });
      },
      { baseTimeoutMs: 100 },
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual([100, 150]);
  });

  test("two timeouts -> third attempt at ORIGINAL timeout succeeds", async () => {
    const calls: number[] = [];
    const result = await runWithCappedRetry(
      ({ timeout, attempt }) => {
        calls.push(timeout);
        if (attempt < 2) {
          return Promise.resolve({
            ok: false as const,
            reason: "timeout" as const,
          });
        }
        return Promise.resolve({ ok: true as const, value: "fine" });
      },
      { baseTimeoutMs: 100 },
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual([100, 150, 100]);
  });

  test("three timeouts -> terminal, never exceeds 3.5x base", async () => {
    const calls: number[] = [];
    const result = await runWithCappedRetry(
      ({ timeout }) => {
        calls.push(timeout);
        return Promise.resolve({
          ok: false as const,
          reason: "timeout" as const,
        });
      },
      { baseTimeoutMs: 200 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("terminal");
      expect(result.reason).toBe("timeout");
    }
    expect(calls).toEqual([200, 300, 200]);
    const total = calls.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(200 * 3.5);
  });

  test("non-timeout failure is not retried (not a retryable reason here)", async () => {
    // runWithCappedRetry only retries "timeout". Other failures bubble up
    // as terminal immediately; caller decides what to do.
    let calls = 0;
    const result = await runWithCappedRetry(
      () => {
        calls += 1;
        return Promise.resolve({
          ok: false as const,
          reason: "schema_violation" as const,
        });
      },
      { baseTimeoutMs: 100 },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("terminal");
      expect(result.reason).toBe("schema_violation");
    }
    expect(calls).toBe(1);
  });

  test("is NOT unbounded: never does a fourth attempt on continuous timeouts", async () => {
    let calls = 0;
    await runWithCappedRetry(
      () => {
        calls += 1;
        return Promise.resolve({
          ok: false as const,
          reason: "timeout" as const,
        });
      },
      { baseTimeoutMs: 10 },
    );

    expect(calls).toBe(3);
  });
});
