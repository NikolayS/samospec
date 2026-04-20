// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §11 — degraded-resolution visibility.
 *
 * Any non-default resolution — lead fallback from Opus to Sonnet, Codex
 * fallback from `gpt-5.1-codex-max` to `gpt-5.1-codex`, or Reviewer B
 * in coupled_fallback — is surfaced to the user:
 *   - `samospec status` prints `running with degraded model resolution:
 *     <summary>` whenever `state.json` records a fallback.
 *   - The first round of a session to enter a degraded resolution
 *     triggers a one-shot prompt: `[accept / abort]` at round start.
 *   - The changelog entry for that round records the degraded
 *     resolution (formatDegradedSummary is used by version.ts too).
 *
 * This module is pure: it reads a snapshot of the adapter resolutions +
 * the coupled_fallback flag, and emits a descriptive line. Callers
 * decide whether to prompt, write to changelog, etc.
 */

export const DEFAULT_LEAD_MODEL = "claude-opus-4-7" as const;
export const DEFAULT_REVIEWER_B_MODEL = "claude-opus-4-7" as const;
export const DEFAULT_CODEX_MODEL = "gpt-5.1-codex-max" as const;

export interface AdapterResolutionSnapshot {
  readonly adapter: string;
  readonly model_id: string;
}

export interface DegradedInput {
  readonly lead: AdapterResolutionSnapshot;
  readonly reviewer_a: AdapterResolutionSnapshot;
  readonly reviewer_b: AdapterResolutionSnapshot;
  readonly coupled_fallback: boolean;
}

export interface DegradedResult {
  readonly degraded: boolean;
  /** Human-readable items suitable for the status line. */
  readonly items: readonly string[];
}

/**
 * Detect any non-default resolution. Returns an itemized list with the
 * seat name + actual model so the status line and changelog carry enough
 * context for a user to decide whether to accept/abort.
 */
export function detectDegradedResolution(
  input: DegradedInput,
): DegradedResult {
  const items: string[] = [];
  if (input.lead.model_id !== DEFAULT_LEAD_MODEL) {
    items.push(`lead fell back to ${input.lead.model_id}`);
  }
  if (input.reviewer_a.model_id !== DEFAULT_CODEX_MODEL) {
    items.push(`reviewer_a fell back to ${input.reviewer_a.model_id}`);
  }
  if (input.reviewer_b.model_id !== DEFAULT_REVIEWER_B_MODEL) {
    items.push(`reviewer_b fell back to ${input.reviewer_b.model_id}`);
  }
  if (input.coupled_fallback) {
    items.push(`coupled_fallback=true (Reviewer B matches lead)`);
  }
  return { degraded: items.length > 0, items };
}

/**
 * Long-form summary for logs and prompts. Example:
 *   "lead fell back to claude-sonnet-4-6, coupled_fallback=true (...)"
 */
export function formatDegradedSummary(result: DegradedResult): string {
  if (!result.degraded) return "";
  return `running with degraded model resolution: ${result.items.join(", ")}`;
}

/**
 * `samospec status` line form. Adds a `- ` bullet prefix so it renders
 * as a list item inside the status output.
 */
export function formatStatusDegradedLine(result: DegradedResult): string {
  if (!result.degraded) return "";
  return `- ${formatDegradedSummary(result)}`;
}
