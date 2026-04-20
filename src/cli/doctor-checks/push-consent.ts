// Copyright 2026 Nikolay Samokhvalov.

/**
 * Doctor check — push consent status per configured remote.
 *
 * SPEC §8: consent is persisted in `.samo/config.json` under
 * `git.push_consent.<remote-url>`. This check enumerates all git
 * remotes and reports the consent decision for each:
 *
 *   - OK    — at least one remote has accepted consent.
 *   - WARN  — at least one remote has refused OR no decision yet.
 *   - FAIL  — no remotes configured.
 *
 * The check is purely informational (never hard-fails on refused
 * consent) — the user may intentionally run local-only.
 */

import { CheckStatus, type CheckResult } from "../doctor-format.ts";
import { loadPersistedConsent } from "../../git/push-consent.ts";

export interface PushConsentCheckArgs {
  /** Absolute repo path. */
  readonly repoPath: string;
  /**
   * Enumeration of configured remotes. Each entry is
   * `{ name: string; url: string }`. Injected for testability.
   */
  readonly remotes: ReadonlyArray<{ readonly name: string; readonly url: string }>;
}

/**
 * Map a persisted consent decision to a short label.
 */
function consentLabel(decision: boolean | null): string {
  if (decision === true) return "OK";
  if (decision === false) return "REFUSED";
  return "NOT YET PROMPTED";
}

export function checkPushConsent(args: PushConsentCheckArgs): CheckResult {
  if (args.remotes.length === 0) {
    return {
      status: CheckStatus.Warn,
      label: "push-consent",
      message: "no remotes configured — push consent not applicable",
    };
  }

  const details: string[] = [];
  let anyOk = false;
  let anyWarn = false;

  for (const remote of args.remotes) {
    let decision: boolean | null = null;
    try {
      decision = loadPersistedConsent({
        repoPath: args.repoPath,
        remoteUrl: remote.url,
      });
    } catch {
      decision = null;
    }
    const label = consentLabel(decision);
    details.push(`${remote.name} (${remote.url}): ${label}`);
    if (decision === true) {
      anyOk = true;
    } else {
      anyWarn = true;
    }
  }

  const status = anyWarn ? CheckStatus.Warn : CheckStatus.Ok;
  return {
    status,
    label: "push-consent",
    message: details.join("; "),
    details,
  };
}
