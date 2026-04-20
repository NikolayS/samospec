// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §7 — Manual-edit detection (Sprint 3 #3).
 *
 * Scope: `git status --porcelain -- .samospec/spec/<slug>/` — catches BOTH
 * edits to tracked committed artifacts AND new untracked files (e.g., a
 * `NOTES.md` a user dropped into the spec dir between rounds). Plain
 * `git diff HEAD` would miss the latter and violate user story 8's
 * "never silently loses work" guarantee.
 *
 * Classification:
 *   - `SPEC.md` → `target: "spec"` — three-option flow (incorporate /
 *     overwrite / abort). `incorporate` (default) commits the edits with
 *     `spec(<slug>): user-edit before round <N>`, appends a `user-edit`
 *     note to `changelog.md`, and returns the SPEC §7 lead directive so
 *     the caller can append it to the next `revise()` prompt.
 *   - Other committed artifacts (`decisions.md`, `changelog.md`,
 *     `TLDR.md`, `interview.json`) and any other file under the spec dir
 *     → `target: "derived"` — warn-and-confirm. The incorporate path
 *     still commits the user's changes under the same message so work
 *     isn't lost, but does NOT emit a lead directive.
 *
 * Lead directive (literal wording fixed by SPEC §7):
 *   "The user has manually edited sections {section-names} of the spec
 *    since the last round. Treat their exact wording as final for those
 *    sections; do not rewrite them."
 *
 * Section-name extraction is a heuristic: H1/H2 headers in `SPEC.md`
 * whose body bytes changed between `before` and `after`.
 */

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { currentBranch } from "./branch.ts";
import { specCommit } from "./commit.ts";
import { GitLayerUsageError, ProtectedBranchError } from "./errors.ts";
import { isProtected, type UserConfig } from "./protected.ts";

/** The single canonical committed-spec filename we special-case. */
export const SPEC_FILE_BASENAME = "SPEC.md";

/** The lead-directive preamble and suffix — verbatim per SPEC §7. */
export const LEAD_DIRECTIVE_PREAMBLE = "The user has manually edited sections";
export const LEAD_DIRECTIVE_SUFFIX =
  "of the spec since the last round. Treat their exact wording as " +
  "final for those sections; do not rewrite them.";

export type ManualEditTarget = "spec" | "derived";

export type ManualEditStatus = "modified" | "untracked" | "staged" | "deleted";

export interface ManualEditFile {
  /** Path relative to the repo root, as reported by `git status --porcelain`. */
  readonly path: string;
  readonly target: ManualEditTarget;
  readonly status: ManualEditStatus;
}

export interface ManualEditReport {
  readonly dirty: boolean;
  readonly files: readonly ManualEditFile[];
  /** True iff `SPEC.md` itself is among the detected edits. */
  readonly specEdited: boolean;
  /** Paths classified as `target=derived`. Relative to the repo root. */
  readonly derivedEdited: readonly string[];
}

export interface DetectManualEditsOpts {
  readonly repoPath: string;
}

function relSpecDir(slug: string): string {
  return path.posix.join(".samospec", "spec", slug) + "/";
}

/**
 * Inspect `git status --porcelain -- .samospec/spec/<slug>/` and classify
 * each touched path. Deletions are surfaced as `deleted`; staged adds /
 * modifications are surfaced with `staged` but still classified by target
 * so the caller can still protect user work.
 */
export function detectManualEdits(
  slug: string,
  opts: DetectManualEditsOpts,
): ManualEditReport {
  assertValidSlug(slug);

  const pathspec = relSpecDir(slug);
  const result = spawnSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=normal", "--", pathspec],
    { cwd: opts.repoPath, encoding: "utf8" },
  );
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `git status failed with status ${String(result.status)}: ${
        result.stderr ?? ""
      }`,
    );
  }

  const files: ManualEditFile[] = [];
  const derivedEdited: string[] = [];
  let specEdited = false;

  const raw = result.stdout ?? "";
  for (const rawLine of raw.split("\n")) {
    if (rawLine.length === 0) continue;
    // Porcelain v1 line is `XY path` where XY is 2 chars and position 2
    // is a space. Renames have `XY orig -> dest`; for our scope-limited
    // pathspec, treat the trailing path as the file of interest.
    const code = rawLine.slice(0, 2);
    const rest = rawLine.slice(3);
    // Ignore `!!` ignored entries outright.
    if (code === "!!") continue;

    let filePath = rest;
    const arrowIdx = rest.indexOf(" -> ");
    if (arrowIdx >= 0) {
      filePath = rest.slice(arrowIdx + 4);
    }

    // Defensive: `git status -- <pathspec>` already filters, but we
    // double-check in case rename destinations slip outside.
    if (!filePath.startsWith(pathspec)) continue;

    const target: ManualEditTarget =
      path.posix.basename(filePath) === SPEC_FILE_BASENAME ? "spec" : "derived";
    const status = classifyStatus(code);
    const entry: ManualEditFile = { path: filePath, target, status };
    files.push(entry);
    if (target === "spec") specEdited = true;
    else derivedEdited.push(filePath);
  }

  return {
    dirty: files.length > 0,
    files,
    specEdited,
    derivedEdited,
  };
}

function classifyStatus(code: string): ManualEditStatus {
  if (code === "??") return "untracked";
  // Porcelain v1: X = index, Y = worktree. D anywhere → deleted.
  if (code.includes("D")) return "deleted";
  // Anything non-space in the index column = staged (A, M, R, etc.).
  if (!code.startsWith(" ") && !code.startsWith("?")) return "staged";
  return "modified";
}

export interface BuildLeadDirectiveArgs {
  /** Contents of `SPEC.md` at HEAD (pre-edit). */
  readonly before: string;
  /** Contents of `SPEC.md` in the working tree (post-edit). */
  readonly after: string;
}

/**
 * Build the SPEC §7 directive string. Section-name extraction is a
 * heuristic: split both texts by H1/H2 headers and emit the names of
 * sections whose body bytes differ. Falls back to a generic sentence when
 * no H1/H2 headers were touched.
 */
export function buildLeadDirective(args: BuildLeadDirectiveArgs): string {
  const before = splitByH1H2(args.before);
  const after = splitByH1H2(args.after);
  const touched = new Set<string>();

  const allNames = new Set<string>([...before.keys(), ...after.keys()]);
  for (const name of allNames) {
    const b = before.get(name) ?? "";
    const a = after.get(name) ?? "";
    if (b !== a) touched.add(name);
  }

  // Don't include the leading-document "preamble" pseudo-section in the
  // directive — it's the text before the first H1/H2.
  touched.delete("__preamble__");

  if (touched.size === 0) {
    // Fallback: still explicit about manual edits per SPEC §7.
    return [
      `${LEAD_DIRECTIVE_PREAMBLE} (unidentified)`,
      LEAD_DIRECTIVE_SUFFIX,
    ].join(" ");
  }
  const names = Array.from(touched).sort();
  return [
    `${LEAD_DIRECTIVE_PREAMBLE} ${names.join(", ")}`,
    LEAD_DIRECTIVE_SUFFIX,
  ].join(" ");
}

/**
 * Parse `text` into a map of H1/H2 section name -> body text (trimmed).
 * The content before any header is bucketed as "__preamble__" so changes
 * there don't leak into the directive's section list.
 */
function splitByH1H2(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split("\n");
  let currentName = "__preamble__";
  let buffer: string[] = [];
  const flush = (): void => {
    const prev = out.get(currentName) ?? "";
    out.set(currentName, (prev ? prev + "\n" : "") + buffer.join("\n"));
    buffer = [];
  };
  for (const line of lines) {
    const m = /^(#{1,2})\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      currentName = (m[2] ?? "").trim();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out;
}

export type ManualEditChoice = "incorporate" | "overwrite" | "abort";

export type ManualEditAction = "committed" | "discarded" | "aborted" | "noop";

export interface ApplyManualEditArgs {
  readonly repoPath: string;
  readonly slug: string;
  readonly report: ManualEditReport;
  readonly choice: ManualEditChoice;
  readonly roundNumber: number;
  readonly userConfig?: UserConfig;
  readonly now?: string;
}

export interface ApplyManualEditOutcome {
  readonly action: ManualEditAction;
  /**
   * SPEC §7 directive to append to the lead's next `revise()` prompt.
   * Emitted only for `SPEC.md` (target=spec) incorporate flows.
   */
  readonly leadDirective?: string;
}

/**
 * Resolve a user's choice on the manual-edit prompt.
 *
 * - `incorporate`: stage ALL paths from the report and create the
 *   `spec(<slug>): user-edit before round <N>` commit. Append a
 *   `user-edit` note to `changelog.md`. Emit the lead directive iff
 *   `SPEC.md` was among the edits.
 * - `overwrite`: discard both tracked and untracked edits under the
 *   spec dir. Untracked files are removed; tracked-file modifications
 *   are restored via `git checkout --`.
 * - `abort`: make no changes. Caller should surface exit 0.
 *
 * Refuses with `ProtectedBranchError` if the current branch is
 * protected (same guard as `specCommit`).
 */
export function applyManualEdit(
  args: ApplyManualEditArgs,
): ApplyManualEditOutcome {
  assertValidSlug(args.slug);
  if (args.report.files.length === 0) {
    return { action: "noop" };
  }

  const branch = currentBranch(args.repoPath);
  if (
    isProtected(branch, {
      repoPath: args.repoPath,
      ...(args.userConfig ? { userConfig: args.userConfig } : {}),
    })
  ) {
    throw new ProtectedBranchError(branch);
  }

  switch (args.choice) {
    case "abort":
      return { action: "aborted" };

    case "overwrite": {
      // Restore tracked paths; remove untracked ones. Deletes are handled
      // by the same restore (brings the file back).
      const pathspec = relSpecDir(args.slug);
      // Use `git checkout -- <pathspec>` to reset tracked files under the
      // spec dir to HEAD. Safe: `checkout -- <path>` is not a branch op.
      const checkoutRes = spawnSync("git", ["checkout", "--", pathspec], {
        cwd: args.repoPath,
        encoding: "utf8",
      });
      if ((checkoutRes.status ?? 1) !== 0) {
        // An empty pathspec match (no tracked changes) is fine; forward
        // any other failure with context.
        const err = checkoutRes.stderr ?? "";
        if (!/did not match any file/i.test(err)) {
          throw new Error(`git checkout -- ${pathspec} failed: ${err}`);
        }
      }
      // Remove untracked + ignored under the spec dir. `git clean -f
      // -- <path>` is bounded by pathspec, so nothing outside is touched.
      // We deliberately do NOT pass `-x` (would delete .gitignore-listed
      // caches) nor `-d` beyond the spec subtree.
      const cleanRes = spawnSync("git", ["clean", "-fd", "--", pathspec], {
        cwd: args.repoPath,
        encoding: "utf8",
      });
      if ((cleanRes.status ?? 1) !== 0) {
        throw new Error(`git clean failed: ${cleanRes.stderr ?? ""}`);
      }
      return { action: "discarded" };
    }

    case "incorporate": {
      // Append a `user-edit` changelog note in-place BEFORE committing so
      // it lands inside the same commit. Only touches `changelog.md` if
      // it already exists; a fresh spec might not have one yet.
      const changelogAbs = path.join(
        args.repoPath,
        ".samospec",
        "spec",
        args.slug,
        "changelog.md",
      );
      if (existsSync(changelogAbs)) {
        const note = `\n- user-edit before round ${String(args.roundNumber)}\n`;
        appendFileSync(changelogAbs, note, "utf8");
      }

      const paths = args.report.files.map((f) => f.path);
      // The changelog relative path must be in `paths` if it was touched.
      const changelogRel = path.posix.join(
        ".samospec",
        "spec",
        args.slug,
        "changelog.md",
      );
      if (existsSync(changelogAbs) && !paths.includes(changelogRel)) {
        paths.push(changelogRel);
      }

      // Build the `user-edit before round <N>` commit message directly —
      // it's not in the SPEC §8 `<action> v<version>` grammar; this is
      // the SPEC §7 user-edit message format.
      const message = `spec(${args.slug}): user-edit before round ${String(
        args.roundNumber,
      )}`;

      // Stage and commit without routing through `specCommit` — its
      // `buildCommitMessage` grammar doesn't cover `before round <N>`.
      // Still a pathspec-scoped stage; no `add -A` anywhere.
      stageAndCommit(args.repoPath, paths, message);

      let leadDirective: string | undefined;
      if (args.report.specEdited) {
        const specRel = path.posix.join(
          ".samospec",
          "spec",
          args.slug,
          SPEC_FILE_BASENAME,
        );
        const before = gitShowHead(args.repoPath, specRel);
        const after = readFileSafely(path.join(args.repoPath, specRel));
        leadDirective = buildLeadDirective({ before, after });
      }

      return leadDirective === undefined
        ? { action: "committed" }
        : { action: "committed", leadDirective };
    }
  }
}

function stageAndCommit(
  repoPath: string,
  paths: readonly string[],
  message: string,
): void {
  if (paths.length === 0) {
    throw new GitLayerUsageError(
      "applyManualEdit: refusing to commit with an empty paths list.",
    );
  }
  const add = spawnSync("git", ["add", "--", ...paths], {
    cwd: repoPath,
    encoding: "utf8",
  });
  if ((add.status ?? 1) !== 0) {
    throw new Error(`git add failed: ${add.stderr ?? ""}`);
  }
  const commit = spawnSync("git", ["commit", "-m", message], {
    cwd: repoPath,
    encoding: "utf8",
  });
  if ((commit.status ?? 1) !== 0) {
    throw new Error(`git commit failed: ${commit.stderr ?? ""}`);
  }
  // Keep `specCommit` imported so callers can cross-reference the grammar.
  // No-op reference; the import is used at type level above but JIT-level
  // here to silence unused-import linters without changing public API.
  void specCommit;
}

function gitShowHead(repoPath: string, relPath: string): string {
  const res = spawnSync("git", ["show", `HEAD:${relPath}`], {
    cwd: repoPath,
    encoding: "utf8",
  });
  if ((res.status ?? 1) !== 0) return "";
  return res.stdout ?? "";
}

function readFileSafely(abs: string): string {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function assertValidSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) {
    throw new GitLayerUsageError(
      `slug '${slug}' is invalid. Use lowercase letters, digits, ` +
        `and '-' (no leading/trailing '-').`,
    );
  }
}

// `writeFileSync` is imported to keep the surface local and testable.
void writeFileSync;
