// Copyright 2026 Nikolay Samokhvalov.

/**
 * Auto-migration for the `.samo/spec/` → `samospec/spec/` and
 * top-level `blueprints/` → `samospec/blueprints/` directory rename.
 *
 * Behavior:
 *   - Idempotent. No-op when the source dir doesn't exist (fresh repo
 *     or already-migrated).
 *   - Refuses to clobber. If both source and destination exist, logs
 *     a warning and leaves both in place — the user can resolve
 *     manually. (We never delete user data.)
 *   - Atomic per-dir via `renameSync`. The move-itself is a single
 *     POSIX rename. If it crosses filesystems we surface the failure
 *     verbatim so the user can move manually.
 *   - Skipped entirely when `.samo/config.json` declares
 *     `paths.spec_dir` or `paths.blueprints_dir` — the user has
 *     opted into a custom layout, our migration heuristic doesn't
 *     apply.
 *
 * Why we live with two separate moves rather than collapsing into a
 * single `samospec/` parent: the SPEC §9 split between mutable
 * working drafts (`spec/`) and immutable promoted blueprints
 * (`blueprints/`) is a load-bearing invariant. Both are configurable
 * independently for users who host briefs on `docs/` or `public/`.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";

import { resolvePaths } from "./paths.ts";

export interface MigrateOptions {
  readonly cwd: string;
  /** Sink for human-readable notices. Defaults to stderr. */
  readonly log?: (line: string) => void;
}

export interface MigrateResult {
  readonly migrated: readonly { from: string; to: string }[];
  readonly skipped: readonly { reason: string; detail?: string }[];
}

/**
 * Move legacy dirs into the resolver's current defaults if missing.
 *
 * Only fires when:
 *   - `.samo/config.json`'s `paths` section is absent or doesn't
 *     override the relevant key (so the user hasn't pinned the
 *     legacy layout).
 *   - The source dir exists and the destination does NOT.
 *
 * Both conditions are independent per-dir: we may migrate `spec/`
 * while leaving the user's already-pinned `blueprints_dir` alone.
 */
export function autoMigrateLegacyDirs(opts: MigrateOptions): MigrateResult {
  const log = opts.log ?? defaultLog;
  const migrated: { from: string; to: string }[] = [];
  const skipped: { reason: string; detail?: string }[] = [];

  const overrides = readPathOverrides(opts.cwd);
  // If the config is so malformed that the resolver throws, defer to
  // the next command to surface the error — migration's job is data
  // safety, not error reporting. Skip cleanly.
  let paths;
  try {
    paths = resolvePaths(opts.cwd);
  } catch (err) {
    skipped.push({
      reason: "resolver threw on config",
      detail: (err as Error).message,
    });
    return { migrated, skipped };
  }

  // -- spec dir --
  const oldSpec = path.join(opts.cwd, ".samo", "spec");
  if (overrides.spec_dir !== undefined) {
    if (existsSync(oldSpec)) {
      skipped.push({
        reason: "spec_dir is configured explicitly",
        detail: oldSpec,
      });
    }
  } else if (existsSync(oldSpec) && !pathsEqual(oldSpec, paths.specDir)) {
    if (existsSync(paths.specDir)) {
      log(
        `samospec: skipping spec dir migration — both '${rel(opts.cwd, oldSpec)}' ` +
          `and '${paths.specDirRel}' exist. Move or remove one to resolve.`,
      );
      skipped.push({
        reason: "destination exists",
        detail: paths.specDir,
      });
    } else {
      try {
        renameSync(oldSpec, paths.specDir);
        log(
          `samospec: migrated '${rel(opts.cwd, oldSpec)}' → ` +
            `'${paths.specDirRel}/'. ` +
            `Update any custom tooling that referenced the old path.`,
        );
        migrated.push({ from: oldSpec, to: paths.specDir });
      } catch (err) {
        log(
          `samospec: spec dir migration failed: ${(err as Error).message}. ` +
            `Move '${rel(opts.cwd, oldSpec)}' → '${paths.specDirRel}/' manually.`,
        );
        skipped.push({
          reason: "rename failed",
          detail: (err as Error).message,
        });
      }
    }
  }

  // -- blueprints dir --
  const oldBp = path.join(opts.cwd, "blueprints");
  if (overrides.blueprints_dir !== undefined) {
    if (existsSync(oldBp)) {
      skipped.push({
        reason: "blueprints_dir is configured explicitly",
        detail: oldBp,
      });
    }
  } else if (existsSync(oldBp) && !pathsEqual(oldBp, paths.blueprintsDir)) {
    if (existsSync(paths.blueprintsDir)) {
      log(
        `samospec: skipping blueprints dir migration — both ` +
          `'${rel(opts.cwd, oldBp)}' and '${paths.blueprintsDirRel}' exist. ` +
          `Move or remove one to resolve.`,
      );
      skipped.push({
        reason: "destination exists",
        detail: paths.blueprintsDir,
      });
    } else {
      try {
        renameSync(oldBp, paths.blueprintsDir);
        log(
          `samospec: migrated '${rel(opts.cwd, oldBp)}/' → ` +
            `'${paths.blueprintsDirRel}/'. ` +
            `Update any committed paths or static-site configs.`,
        );
        migrated.push({ from: oldBp, to: paths.blueprintsDir });
      } catch (err) {
        log(
          `samospec: blueprints dir migration failed: ${(err as Error).message}. ` +
            `Move '${rel(opts.cwd, oldBp)}' → '${paths.blueprintsDirRel}/' ` +
            `manually.`,
        );
        skipped.push({
          reason: "rename failed",
          detail: (err as Error).message,
        });
      }
    }
  }

  return { migrated, skipped };
}

// ---------- internals ----------

interface PathOverrides {
  readonly spec_dir?: string;
  readonly blueprints_dir?: string;
}

function readPathOverrides(cwd: string): PathOverrides {
  const file = path.join(cwd, ".samo", "config.json");
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Malformed config? `resolvePaths` will throw on next access; for
    // migration purposes treat as "no overrides" and let the next
    // command surface the real error.
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const pathsField = (raw as { paths?: unknown }).paths;
  if (
    typeof pathsField !== "object" ||
    pathsField === null ||
    Array.isArray(pathsField)
  ) {
    return {};
  }
  const out: { spec_dir?: string; blueprints_dir?: string } = {};
  const sd = (pathsField as { spec_dir?: unknown }).spec_dir;
  if (typeof sd === "string" && sd.length > 0) out.spec_dir = sd;
  const bd = (pathsField as { blueprints_dir?: unknown }).blueprints_dir;
  if (typeof bd === "string" && bd.length > 0) out.blueprints_dir = bd;
  return out;
}

function pathsEqual(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function rel(cwd: string, p: string): string {
  const r = path.relative(cwd, p);
  return r === "" ? "." : r;
}

function defaultLog(line: string): void {
  process.stderr.write(`${line}\n`);
}
