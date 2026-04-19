// Copyright 2026 Nikolay Samokhvalov.

import { CheckStatus, type CheckResult } from "../doctor-format.ts";

import type { AdapterBinding } from "./availability.ts";

export interface CheckAuthStatusArgs {
  readonly adapters: readonly AdapterBinding[];
}

/**
 * Aggregates `auth_status()` across every bound adapter. Statuses:
 *
 *   - OK   — every adapter authenticated with API-key auth (usage
 *            tracking available).
 *   - WARN — at least one adapter authenticated via subscription
 *            (SPEC §11 subscription-auth escape — usage unavailable;
 *            wall-clock + iteration caps enforced instead).
 *   - FAIL — any adapter not authenticated.
 *
 * Uses the existing `auth_status()` stub from Issue #5 — does NOT
 * reimplement the subscription-auth heuristic.
 */
export async function checkAuthStatus(
  args: CheckAuthStatusArgs,
): Promise<CheckResult> {
  const details: string[] = [];
  let anyFailure = false;
  let anySubscription = false;

  for (const { label, adapter } of args.adapters) {
    try {
      const status = await adapter.auth_status();
      if (!status.authenticated) {
        details.push(`${label}: not authenticated`);
        anyFailure = true;
        continue;
      }
      if (status.subscription_auth === true) {
        anySubscription = true;
        const account =
          status.account !== undefined ? ` (${status.account})` : "";
        details.push(
          `${label}: authenticated via subscription${account} ` +
            `— token cost not visible; wall-clock + iteration caps enforced`,
        );
      } else {
        const account =
          status.account !== undefined ? ` (${status.account})` : "";
        details.push(`${label}: authenticated${account}`);
      }
    } catch (err) {
      details.push(`${label}: auth_status threw: ${(err as Error).message}`);
      anyFailure = true;
    }
  }

  let status: CheckStatus;
  if (anyFailure) status = CheckStatus.Fail;
  else if (anySubscription) status = CheckStatus.Warn;
  else status = CheckStatus.Ok;

  return {
    status,
    label: "auth",
    message: details.join("; "),
    details,
  };
}
