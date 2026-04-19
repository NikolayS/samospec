// Copyright 2026 Nikolay Samokhvalov.

// SPEC §7 capped retry policy for work-call timeouts.
// original timeout -> retry at +50% timeout -> retry at original timeout
// After three total attempts ending in timeout, the seat is terminal.
// Worst case total: base + 1.5*base + base = 3.5*base.

export interface AttemptContext {
  readonly attempt: number;
  readonly timeout: number;
}

export interface AttemptOk<T> {
  readonly ok: true;
  readonly value: T;
}
export interface AttemptFail {
  readonly ok: false;
  readonly reason: "timeout" | "schema_violation" | "other";
  readonly detail?: string;
}
export type AttemptResult<T> = AttemptOk<T> | AttemptFail;

export type RetryOutcome<T> =
  | AttemptOk<T>
  | {
      readonly ok: false;
      readonly kind: "terminal";
      readonly reason: AttemptFail["reason"];
      readonly detail?: string;
      readonly attempts: number;
    };

export function computeAttemptTimeouts(
  baseMs: number,
): readonly [number, number, number] {
  if (!Number.isFinite(baseMs) || baseMs <= 0) {
    throw new Error(
      `baseTimeoutMs must be a finite positive number, got ${String(baseMs)}`,
    );
  }
  const plusHalf = Math.floor(baseMs * 1.5);
  return [baseMs, plusHalf, baseMs];
}

export interface RunWithCappedRetryOpts {
  readonly baseTimeoutMs: number;
}

export async function runWithCappedRetry<T>(
  run: (ctx: AttemptContext) => Promise<AttemptResult<T>>,
  opts: RunWithCappedRetryOpts,
): Promise<RetryOutcome<T>> {
  const timeouts = computeAttemptTimeouts(opts.baseTimeoutMs);

  let lastFail: AttemptFail | null = null;
  for (let attempt = 0; attempt < timeouts.length; attempt += 1) {
    const timeout = timeouts[attempt];
    if (timeout === undefined) break;
    const outcome = await run({ attempt, timeout });
    if (outcome.ok) {
      return outcome;
    }
    lastFail = outcome;
    // Only timeouts are retryable inside this helper. Any other
    // failure (schema_violation, auth, 4xx, etc.) bubbles up
    // immediately; the caller decides whether a repair-retry
    // applies (that's a separate concern — see SPEC §7 on
    // `critique()` schema-repair retry).
    if (outcome.reason !== "timeout") {
      break;
    }
  }

  // `lastFail` is non-null: either we consumed all attempts or bailed early.
  const fail = lastFail;
  if (fail === null) {
    // Defensive; only reachable if timeouts is empty which is impossible.
    throw new Error("runWithCappedRetry: no attempts were run");
  }
  const base: {
    readonly ok: false;
    readonly kind: "terminal";
    readonly reason: AttemptFail["reason"];
    readonly attempts: number;
  } = {
    ok: false,
    kind: "terminal",
    reason: fail.reason,
    attempts:
      fail.reason === "timeout"
        ? timeouts.length
        : timeouts.findIndex((_v, i) => i === 0) + 1,
  };
  return fail.detail !== undefined ? { ...base, detail: fail.detail } : base;
}
