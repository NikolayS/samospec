// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §7 — `lead_terminal` exit-4 messaging.
 *
 * Sub-reasons are mandatorily distinct per SPEC §7:
 *   - refusal        → "model refused — edit SPEC.md … or retry"
 *   - schema_fail    → "adapter returned invalid structured output — …"
 *   - invalid_input  → "spec too large or malformed — check SPEC.md"
 *   - budget         → "budget cap hit — downshift via --effort …"
 *   - wall_clock     → "session wall-clock hit — resume to continue"
 *   - adapter_error  → generic catch-all (still marked lead_terminal)
 *
 * This module owns the classification heuristic (`classifyReviseError`)
 * and the per-sub-reason message table (`formatLeadTerminalMessage`) so
 * both `src/cli/draft.ts` (v0.1 draft) and `src/cli/iterate.ts` (review
 * loop) surface the same copy for the same failure class. `draft.ts`
 * re-exports these for back-compat; the tests for both are unchanged.
 */

export type LeadTerminalSubReason =
  | "refusal"
  | "schema_fail"
  | "invalid_input"
  | "budget"
  | "wall_clock"
  | "adapter_error";

/**
 * Classify a thrown error from a lead `revise()` call into the SPEC §7
 * sub-reason taxonomy. Uses the adapter's error-message substring to
 * distinguish refusal / schema / invalid-input / budget / wall-clock
 * from a generic adapter failure.
 *
 * The mapping is intentionally substring-based: adapters surface
 * failures through `Error.message` and the caller-side classification
 * has to work across vendors without a dedicated error class hierarchy.
 * If none of the patterns match, the error is still treated as
 * `lead_terminal` but labelled `adapter_error`.
 */
export function classifyLeadTerminal(err: unknown): {
  readonly sub_reason: LeadTerminalSubReason;
  readonly detail: string;
} {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const lower = message.toLowerCase();
  if (lower.includes("refus")) {
    return { sub_reason: "refusal", detail: message };
  }
  if (lower.includes("schema")) {
    return { sub_reason: "schema_fail", detail: message };
  }
  if (lower.includes("invalid input") || lower.includes("too large")) {
    return { sub_reason: "invalid_input", detail: message };
  }
  // Check wall-clock BEFORE budget: the phrase "wall-clock budget"
  // legitimately appears in some error messages, and wall_clock is the
  // more specific classification (SPEC §7 gives it its own distinct
  // exit-4 copy).
  if (lower.includes("wall-clock") || lower.includes("wall clock")) {
    return { sub_reason: "wall_clock", detail: message };
  }
  if (lower.includes("budget")) {
    return { sub_reason: "budget", detail: message };
  }
  return { sub_reason: "adapter_error", detail: message };
}

/**
 * Canonical SPEC §7 exit-4 copy per sub-reason. Callers print this to
 * stderr alongside their own state-persistence notices.
 */
export function formatLeadTerminalMessage(
  slug: string,
  sub: LeadTerminalSubReason,
  detail: string,
): string {
  const detailSuffix = detail.length > 0 ? ` (${detail})` : "";
  switch (sub) {
    case "refusal":
      return (
        `samospec: lead_terminal — model refused. ` +
        `Edit .samo/spec/${slug}/SPEC.md to remove sensitive content ` +
        `or retry.${detailSuffix}`
      );
    case "schema_fail":
      return (
        `samospec: lead_terminal — adapter returned invalid structured output. ` +
        `File a samospec bug or switch adapter.${detailSuffix}`
      );
    case "invalid_input":
      return (
        `samospec: lead_terminal — spec too large or malformed. ` +
        `Check .samo/spec/${slug}/SPEC.md.${detailSuffix}`
      );
    case "budget":
      return (
        `samospec: lead_terminal — budget cap hit. ` +
        `Downshift via --effort or raise budget.*.${detailSuffix}`
      );
    case "wall_clock":
      return (
        `samospec: lead_terminal — session wall-clock hit. ` +
        `Resume to continue.${detailSuffix}`
      );
    case "adapter_error":
      return (
        `samospec: lead_terminal — adapter error. ` +
        `See .samo/spec/${slug}/ for state and retry.${detailSuffix}`
      );
  }
}
