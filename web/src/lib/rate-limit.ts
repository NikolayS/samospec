import { sql } from "./db";

// Per-spec exponential backoff for failed access-code attempts. We rate
// limit by spec hash (not by IP) because we don't trust the client IP by
// default — see auth.ts:publisherIp.
//
// Schedule, applied as `now() + LOCKOUT_FOR(failures)`:
//   1- 4 failures: no lockout (legit user typos happen)
//   5- 9 failures: 30 s
//   10-19:         5 min
//   20-49:         1 h
//   50+:           24 h
//
// On a correct code we reset failures to 0 and clear locked_until. With
// the 32^6 ≈ 1.07e9 code space, even the leakiest tier (50 attempts per
// 24h ≈ 18250/yr) needs ~58000 years to exhaust on average — and the
// schedule slows much faster than that.

export type RateLimitState =
  | { ok: true }
  | { ok: false; retryAfterSec: number };

export async function checkLocked(hash: string): Promise<RateLimitState> {
  const rows = await sql<{ locked_until: Date | null }[]>`
    select code_locked_until as locked_until
      from specs
     where hash = ${hash}
     limit 1
  `;
  const lock = rows[0]?.locked_until;
  if (!lock) return { ok: true };
  const remainingMs = lock.getTime() - Date.now();
  if (remainingMs <= 0) return { ok: true };
  return { ok: false, retryAfterSec: Math.ceil(remainingMs / 1000) };
}

export async function recordFailure(hash: string): Promise<void> {
  // Compute the next failure count and corresponding lockout in one SQL
  // round-trip. PostgreSQL handles the arithmetic; we just supply the
  // schedule via CASE.
  await sql`
    update specs
       set code_failures     = code_failures + 1,
           code_locked_until = case
             when code_failures + 1 < 5  then null
             when code_failures + 1 < 10 then now() + interval '30 seconds'
             when code_failures + 1 < 20 then now() + interval '5 minutes'
             when code_failures + 1 < 50 then now() + interval '1 hour'
             else now() + interval '24 hours'
           end
     where hash = ${hash}
  `;
}

export async function recordSuccess(hash: string): Promise<void> {
  await sql`
    update specs
       set code_failures = 0, code_locked_until = null
     where hash = ${hash}
       and (code_failures <> 0 or code_locked_until is not null)
  `;
}
