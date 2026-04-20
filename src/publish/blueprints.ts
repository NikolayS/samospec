// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §5 Phase 7 + §9 — blueprint promotion.
 *
 * Copies `.samo/spec/<slug>/SPEC.md` → `blueprints/<slug>/SPEC.md`,
 * creating `blueprints/<slug>/` when missing. The blueprint is a
 * promoted snapshot — SPEC §9 states it is **never hand-edited**. Any
 * revisions go back through `samospec iterate` + `samospec publish`
 * (the v1.1 plan includes a distinct `samospec tag` for release
 * markers; out of scope here).
 *
 * This helper is idempotent by design: a stray manual re-run overwrites
 * the existing blueprint with the current working SPEC.md. `runPublish`
 * itself rejects republish via the `published_*` fields in state.json;
 * the safety net here is only for callers wiring the primitive
 * directly.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface PromoteOpts {
  readonly cwd: string;
  readonly slug: string;
}

/**
 * Copy the working SPEC.md into `blueprints/<slug>/`. Returns the
 * absolute destination path so callers can stage it before committing.
 *
 * Throws if the source SPEC.md is missing — the caller is expected to
 * have validated the phase is `committed` before invoking this; a
 * missing source means the preconditions check above was bypassed.
 */
export function promoteSpecToBlueprint(opts: PromoteOpts): string {
  const src = path.join(opts.cwd, ".samo", "spec", opts.slug, "SPEC.md");
  if (!existsSync(src)) {
    throw new Error(
      `SPEC.md not found at ${src}. ` +
        `Run \`samospec resume ${opts.slug}\` to produce a draft before publishing.`,
    );
  }
  const dir = path.join(opts.cwd, "blueprints", opts.slug);
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "SPEC.md");
  copyFileSync(src, dest);
  return dest;
}
