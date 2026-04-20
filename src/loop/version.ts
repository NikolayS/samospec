// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §7 + §5 Phase 6 — version bump helper + changelog formatter.
 *
 * The loop bumps `v0.1 → v0.2 → ...` on each successful round via
 * `bumpMinor`. The stored field in `state.json` is the full semver
 * triple (`X.Y.Z`); the UI label is the short `vX.Y` per SPEC §5.
 *
 * The changelog entry records the per-round decision counts
 * (accepted / rejected / deferred) so downstream readers can see at a
 * glance how the lead handled each round's critique panel.
 */

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function bumpMinor(semver: string): string {
  const m = SEMVER_RE.exec(semver);
  if (m === null) {
    throw new Error(`bumpMinor: expected X.Y.Z, received '${semver}'.`);
  }
  const major = Number.parseInt(m[1] ?? "0", 10);
  const minor = Number.parseInt(m[2] ?? "0", 10);
  return `${String(major)}.${String(minor + 1)}.0`;
}

/** Short label for UI / changelog / commit messages: `v0.2`, `v1.3.1`. */
export function formatVersionLabel(semver: string): string {
  const m = SEMVER_RE.exec(semver);
  if (m === null) {
    return `v${semver}`;
  }
  const major = m[1] ?? "0";
  const minor = m[2] ?? "0";
  const patch = m[3] ?? "0";
  if (patch === "0") return `v${major}.${minor}`;
  return `v${major}.${minor}.${patch}`;
}

export interface ChangelogEntryInput {
  readonly version: string;
  readonly now: string;
  readonly roundNumber: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly deferred: number;
  /** When any adapter is running under a non-default resolution. */
  readonly degradedResolution?: string;
  /** Optional suffix notes (e.g., reviewer unavailability). */
  readonly notes?: readonly string[];
}

export function formatChangelogEntry(input: ChangelogEntryInput): string {
  const lines: string[] = [];
  lines.push(`## ${formatVersionLabel(input.version)} — ${input.now}`);
  lines.push("");
  lines.push(
    `- Round ${String(input.roundNumber)} reviews applied (decisions — ` +
      `accepted: ${String(input.accepted)}, ` +
      `rejected: ${String(input.rejected)}, ` +
      `deferred: ${String(input.deferred)}).`,
  );
  if (
    input.degradedResolution !== undefined &&
    input.degradedResolution.length > 0
  ) {
    lines.push(`- Degraded resolution: ${input.degradedResolution}.`);
  }
  for (const note of input.notes ?? []) {
    lines.push(`- ${note}`);
  }
  lines.push("");
  return lines.join("\n");
}
