// Copyright 2026 Nikolay Samokhvalov.

import { CheckStatus, type CheckResult } from "../doctor-format.ts";

import type { AdapterBinding } from "./availability.ts";

export interface CheckAuthStatusArgs {
  readonly adapters: readonly AdapterBinding[];
}

// Map from adapter label to the required API key env var name.
// Used in subscription-auth WARN messages to point at the right env var.
const ADAPTER_API_KEY_ENV: Readonly<Record<string, string>> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
};

function apiKeyEnvForLabel(label: string): string {
  return ADAPTER_API_KEY_ENV[label] ?? "the required API key env var";
}

/**
 * Aggregates `auth_status()` across every bound adapter. Statuses:
 *
 *   - OK   — every adapter authenticated and usable for non-interactive
 *            work calls (API key present).
 *   - WARN — at least one adapter authenticated via subscription but
 *            without the matching API key env var — cannot run non-
 *            interactive work calls (SPEC §11). `doctor` surfaces the
 *            required env var so the user knows what to set.
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
  let anySubscriptionNotUsable = false;

  for (const { label, adapter } of args.adapters) {
    try {
      const status = await adapter.auth_status();
      if (!status.authenticated) {
        details.push(`${label}: not authenticated`);
        anyFailure = true;
        continue;
      }
      // subscription_auth:true AND usable_for_noninteractive:false means
      // the adapter is authenticated but cannot run --print mode work calls.
      if (
        status.subscription_auth === true &&
        status.usable_for_noninteractive === false
      ) {
        anySubscriptionNotUsable = true;
        const apiKeyVar = apiKeyEnvForLabel(label);
        const account =
          status.account !== undefined ? ` (${status.account})` : "";
        details.push(
          `${label}: subscription auth detected${account}; ` +
            `samospec requires ${apiKeyVar} for non-interactive invocation`,
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
  else if (anySubscriptionNotUsable) status = CheckStatus.Warn;
  else status = CheckStatus.Ok;

  return {
    status,
    label: "auth",
    message: details.join("; "),
    details,
  };
}
