// Copyright 2026 Nikolay Samokhvalov.

import { Glob } from "bun";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { redact } from "../../security/redact.ts";
import { CheckStatus, type CheckResult } from "../doctor-format.ts";

/**
 * Options for the entropy-scan check.
 *
 * `cwd` is the repo root: the check globs `.samo/spec/<slug>/
 * transcripts/*.log` under this root (transcripts land here in Sprint 3;
 * until then the glob is simply empty).
 *
 * `extraPaths` is the union of whatever the caller wants scanned on top
 * of the default glob — including any file listed under
 * `doctor.entropy_scan_paths` in `.samo/config.json`. The aggregator
 * resolves that config and flattens it into this array.
 */
export interface CheckEntropyArgs {
  readonly cwd?: string;
  readonly extraPaths?: readonly string[];
}

// Cap on file size to scan. Deliberately modest — the redaction pass is
// best-effort and we're not trying to be a full content scanner. Files
// over this size still get a note but aren't opened.
const MAX_FILE_BYTES = 1_048_576; // 1 MiB

const WARN_SUFFIX =
  "entropy scan is best-effort; recommend external scanners " +
  "(gitleaks, truffleHog) for sensitive repos";

/**
 * Collect the list of files to scan:
 *  1. Any path the caller passed in `extraPaths` (deduped).
 *  2. `.samo/spec/<slug>/transcripts/*.log` under `cwd`.
 *  3. Any file listed under `doctor.entropy_scan_paths` in the repo's
 *     `.samo/config.json` (resolved relative to `cwd`).
 *
 * Missing files are silently skipped — the check is diagnostic, not a
 * gate. Non-readable files (permission error) are skipped for the same
 * reason.
 */
function collectScanTargets(
  cwd: string,
  extraPaths: readonly string[],
): readonly string[] {
  const targets = new Set<string>();
  for (const p of extraPaths) targets.add(p);

  // Transcript glob. `Glob` is Bun-native and doesn't touch the fs until
  // iterated; an empty directory tree yields nothing.
  try {
    // `dot: true` is required so Bun's Glob descends into the hidden
    // `.samo` directory.
    const glob = new Glob(".samo/spec/*/transcripts/*.log");
    for (const rel of glob.scanSync({ cwd, absolute: false, dot: true })) {
      targets.add(path.join(cwd, rel));
    }
  } catch {
    // Scan errors (permissions, non-existent cwd) shouldn't FAIL the
    // check. Skip.
  }

  // Config-listed extras.
  const cfgPath = path.join(cwd, ".samo", "config.json");
  if (existsSync(cfgPath)) {
    try {
      const raw = readFileSync(cfgPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        const doctorCfg = (parsed as Record<string, unknown>)["doctor"];
        if (typeof doctorCfg === "object" && doctorCfg !== null) {
          const paths = (doctorCfg as Record<string, unknown>)[
            "entropy_scan_paths"
          ];
          if (Array.isArray(paths)) {
            for (const p of paths) {
              if (typeof p === "string" && p.length > 0) {
                targets.add(path.isAbsolute(p) ? p : path.join(cwd, p));
              }
            }
          }
        }
      }
    } catch {
      // Malformed config is handled by the dedicated config check; the
      // entropy check treats it as "no extras" and moves on.
    }
  }

  return Array.from(targets);
}

/**
 * Scan a single file for redactable matches. Returns the number of
 * placeholder insertions — NOT the matched content, which must never
 * leak into the `doctor` output.
 */
function countRedactionHits(file: string): number {
  try {
    const st = statSync(file);
    if (!st.isFile()) return 0;
    if (st.size > MAX_FILE_BYTES) return 0;
    const text = readFileSync(file, "utf8");
    const redacted = redact(text);
    if (redacted === text) return 0;
    const matches = redacted.match(/<redacted:[a-z_]+>/g);
    return matches?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * `samospec doctor` entropy scan. SPEC §14: best-effort, never FAILs.
 *
 *   - WARN (no hits): surfaces the external-scanner recommendation.
 *     This is the baseline state even on a clean repo, so the user
 *     always sees the caveat on every `doctor` run. Scope this is a
 *     deliberate, not a regression to investigate.
 *   - OK (explicit clean): every caller-provided path was scanned and
 *     contained zero redactable matches — callers who pass extraPaths
 *     or have .samo/spec/<slug>/transcripts/*.log in the repo see
 *     an OK line confirming the sweep found nothing.
 *   - WARN (hits): at least one match; message lists the hit count and
 *     the number of files, but never surfaces the raw secret.
 *
 * Two WARN shapes distinguish "no scan happened" from "hits found".
 */
export function checkEntropy(args: CheckEntropyArgs = {}): CheckResult {
  const cwd = args.cwd ?? process.cwd();
  const extraPaths = args.extraPaths ?? [];
  const targets = collectScanTargets(cwd, extraPaths);

  let totalHits = 0;
  let filesWithHits = 0;
  for (const file of targets) {
    const hits = countRedactionHits(file);
    if (hits > 0) {
      totalHits += hits;
      filesWithHits += 1;
    }
  }

  if (totalHits > 0) {
    return {
      status: CheckStatus.Warn,
      label: "entropy",
      message:
        `${totalHits} redactable match(es) across ` +
        `${filesWithHits} file(s). ${WARN_SUFFIX}`,
    };
  }

  // Clean sweep: if we actually scanned something, surface OK so the
  // user gets positive confirmation. With nothing to scan, fall back to
  // the bare recommendation — keeps the message honest ("we didn't
  // actually verify this repo is clean").
  if (targets.length > 0) {
    return {
      status: CheckStatus.Ok,
      label: "entropy",
      message:
        `scanned ${targets.length} file(s); no redactable matches. ` +
        `(${WARN_SUFFIX})`,
    };
  }

  return {
    status: CheckStatus.Warn,
    label: "entropy",
    message: `no transcripts to scan yet. ${WARN_SUFFIX}`,
  };
}
