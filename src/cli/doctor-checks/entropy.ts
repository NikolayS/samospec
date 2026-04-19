// Copyright 2026 Nikolay Samokhvalov.

import { CheckStatus, type CheckResult } from "../doctor-format.ts";

/**
 * Entropy-scan placeholder. SPEC §14 + Issue #4 acceptance: surface the
 * message without attempting an actual scan — this sprint doesn't own
 * the redaction corpus or the scanner harness (that's Sprint 4). The
 * WARN is deliberate: it communicates a real, known limitation.
 */
export function checkEntropy(): CheckResult {
  return {
    status: CheckStatus.Warn,
    label: "entropy",
    message:
      "secret/entropy scan is best-effort; recommend an external scanner " +
      "(gitleaks, truffleHog) for sensitive repos",
  };
}
