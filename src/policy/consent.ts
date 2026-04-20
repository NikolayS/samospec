// Copyright 2026 Nikolay Samokhvalov.

// SPEC §5 Phase 1 + §11 preflight consent gate.
//
// Fires when:
//   - `preflight.likelyUsd > budget.preflight_confirm_usd`, OR
//   - any adapter returned `usage: null` (preflight can't actually
//     price it — spec explicitly widens the gate here).
//
// Three outcomes:
//   - accept     -> proceed.
//   - downshift  -> run one session at effort=high (not persisted).
//   - abort      -> exit 5 per SPEC §10 (consent refused).
//
// Testable without a TTY: callers pass `opts.answer`. Sprint 3 will
// wire the real prompt via the CLI.

/** SPEC §10 exit-code table: consent refused -> 5. */
export const CONSENT_ABORT_EXIT_CODE = 5 as const;

export interface PreflightForConsent {
  /** The preflight P50 in USD (priced adapters only). */
  readonly likelyUsd: number;
  /**
   * True when any adapter's preflight could not be priced
   * (usage: null — subscription auth or buggy adapter).
   */
  readonly anyUsageNull: boolean;
}

export type ConsentAnswer = "accept" | "downshift" | "abort";

export interface PromptConsentOpts {
  readonly preflight: PreflightForConsent;
  readonly thresholdUsd: number;
  /**
   * Injected answer for tests / scripted flows. When the gate fires
   * and no answer is supplied, `promptConsent` throws — Sprint 3 wires
   * a real stdin/prompt adapter behind this.
   */
  readonly answer?: ConsentAnswer;
}

export interface ConsentResult {
  readonly decision: ConsentAnswer;
  /** Effort level to clamp this session to on `downshift`. */
  readonly sessionEffort?: "high";
  /** True if this decision mutates `.samospec/config.json`. */
  readonly persist?: boolean;
  /** Process exit code when `decision === 'abort'`. */
  readonly exitCode?: number;
}

/**
 * Rule: threshold is a strict > check (equal means "at the limit, fine"),
 * and any usage-null adapter also trips the gate regardless of price.
 */
export function shouldPromptConsent(
  p: PreflightForConsent,
  thresholdUsd: number,
): boolean {
  if (p.anyUsageNull) return true;
  return p.likelyUsd > thresholdUsd;
}

export function promptConsent(opts: PromptConsentOpts): ConsentResult {
  const { preflight, thresholdUsd, answer } = opts;
  if (!shouldPromptConsent(preflight, thresholdUsd)) {
    return { decision: "accept" };
  }
  if (answer === undefined) {
    throw new Error(
      "consent gate fired but no answer was supplied — wire a " +
        "prompt or inject opts.answer",
    );
  }
  return decide(answer);
}

function decide(answer: ConsentAnswer): ConsentResult {
  switch (answer) {
    case "accept":
      return { decision: "accept" };
    case "downshift":
      return {
        decision: "downshift",
        sessionEffort: "high",
        persist: false,
      };
    case "abort":
      return { decision: "abort", exitCode: CONSENT_ABORT_EXIT_CODE };
    default:
      // Any unknown string (including typos) falls through to a
      // fail-safe abort so we never accidentally proceed.
      return { decision: "abort", exitCode: CONSENT_ABORT_EXIT_CODE };
  }
}
