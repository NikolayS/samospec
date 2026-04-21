// Copyright 2026 Nikolay Samokhvalov.

/**
 * Archive helper for `samospec new <slug> --force`.
 *
 * SPEC §10: the --force variant archives the old slug directory to
 *   `.samo/spec/<slug>.archived-<timestamp>/`
 * Timestamp format: YYYY-MM-DDThhmmssZ (ISO 8601 UTC, no colons —
 * Windows-portable).
 *
 * Collision handling: if the target dir already exists (two --force
 * runs in the same second), append -1, -2, … until a free path is
 * found.
 */

import { existsSync, renameSync } from "node:fs";
import path from "node:path";

export interface ArchiveArgs {
  /** `.samo/spec/` directory (parent of slug dirs). */
  readonly specsDir: string;
  /** The spec slug whose directory to archive. */
  readonly slug: string;
  /** Reference time for the timestamp. Defaults to `new Date()`. */
  readonly now?: Date;
}

export type ArchiveResult =
  | { readonly kind: "archived"; readonly archivedPath: string }
  | { readonly kind: "not-found" };

/**
 * Format a Date as `YYYY-MM-DDThhmmssZ` — ISO 8601 UTC, colons
 * stripped so the name is valid on Windows filesystems.
 */
export function makeArchiveTimestamp(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const h = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}${mi}${s}Z`;
}

/**
 * Archive `.samo/spec/<slug>/` to `.samo/spec/<slug>.archived-<ts>/`.
 *
 * Returns `{ kind: "archived", archivedPath }` on success, or
 * `{ kind: "not-found" }` when the slug dir does not exist.
 */
export function archiveSlugDir(args: ArchiveArgs): ArchiveResult {
  const slugDir = path.join(args.specsDir, args.slug);

  if (!existsSync(slugDir)) {
    return { kind: "not-found" };
  }

  const ts = makeArchiveTimestamp(args.now ?? new Date());
  const base = `${args.slug}.archived-${ts}`;

  // Find a free target path (collision counter: -1, -2, …).
  let targetPath = path.join(args.specsDir, base);
  let counter = 0;
  while (existsSync(targetPath)) {
    counter += 1;
    targetPath = path.join(args.specsDir, `${base}-${String(counter)}`);
  }

  renameSync(slugDir, targetPath);

  return { kind: "archived", archivedPath: targetPath };
}
