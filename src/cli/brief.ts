// Copyright 2026 Nikolay Samokhvalov.

/**
 * `samospec brief <slug>` — generate a summarized HTML brief from a
 * published spec.
 *
 * Contract (v1):
 *   - The brief is a *derivative summary* of the canonical SPEC.md,
 *     not the spec itself. Naming and copy emphasize this so readers
 *     never mistake it for the source of truth.
 *   - Requires a published spec (state.published_at present).
 *   - Reads `<blueprints_dir>/<slug>/SPEC.md` as the canonical source.
 *     Reads `<spec_dir>/<slug>/{state.json,TLDR.md,changelog.md}` for
 *     metadata and round history.
 *   - Writes `<blueprints_dir>/<slug>/BRIEF.html` by default; `--out`
 *     overrides for users hosting on `docs/`, `public/`, etc.
 *   - Idempotently creates `.nojekyll` at the repo root so committed
 *     briefs Just Work on GitHub Pages (Jekyll skips dotfile dirs by
 *     default; even though our default output isn't dotfile-prefixed,
 *     a `.nojekyll` is harmless and future-proofs alt configurations).
 *     `--no-nojekyll` opts out.
 *   - Does NOT auto-commit. The brief is a derivative; users decide
 *     whether and when to commit it. Stdout prints the next step.
 *
 * Exit codes (per SPEC §10):
 *   - 0 success
 *   - 1 user error (no slug, not published, missing files, malformed
 *       state.json)
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { briefHtmlPath, specSlugDir, blueprintSpecPath } from "../paths.ts";
import { renderBrief } from "../render/brief.ts";
import { stateSchema, type State } from "../state/types.ts";

export interface BriefInput {
  readonly cwd: string;
  readonly slug: string;
  /** ISO timestamp embedded in the brief's footer. */
  readonly now: string;
  /**
   * Override the output path. Repo-relative or absolute. When unset,
   * defaults to `<blueprints_dir>/<slug>/BRIEF.html`.
   */
  readonly out?: string;
  /** When true, do not create/touch the repo-root `.nojekyll` marker. */
  readonly noNojekyll?: boolean;
}

export interface BriefResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runBrief(input: BriefInput): BriefResult {
  const out: string[] = [];
  const err: string[] = [];

  if (input.slug.trim() === "") {
    err.push("samospec brief: missing <slug>.");
    return finish(1, out, err);
  }

  const slugDir = specSlugDir(input.cwd, input.slug);
  const statePath = path.join(slugDir, "state.json");
  const tldrPath = path.join(slugDir, "TLDR.md");
  const changelogPath = path.join(slugDir, "changelog.md");
  const blueprintSpec = blueprintSpecPath(input.cwd, input.slug);

  if (!existsSync(statePath)) {
    err.push(
      `samospec brief: no spec found for slug '${input.slug}'. ` +
        `Run \`samospec new ${input.slug}\` first.`,
    );
    return finish(1, out, err);
  }

  let state: State;
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as unknown;
    const parsed = stateSchema.safeParse(raw);
    if (!parsed.success) {
      err.push(
        `samospec brief: state.json at ${statePath} is malformed: ${parsed.error.message}`,
      );
      return finish(1, out, err);
    }
    state = parsed.data;
  } catch (e) {
    err.push(`samospec brief: cannot read state.json: ${(e as Error).message}`);
    return finish(1, out, err);
  }

  if (state.published_at === undefined) {
    err.push(
      `samospec brief: '${input.slug}' is not yet published. ` +
        `Run \`samospec publish ${input.slug}\` first — the brief summarizes ` +
        `the published snapshot, not the working draft.`,
    );
    return finish(1, out, err);
  }

  if (!existsSync(blueprintSpec)) {
    err.push(
      `samospec brief: published SPEC.md missing at ${blueprintSpec}. ` +
        `Re-run \`samospec publish ${input.slug}\`.`,
    );
    return finish(1, out, err);
  }

  const spec = readFileSync(blueprintSpec, "utf8");
  const tldr = existsSync(tldrPath) ? readFileSync(tldrPath, "utf8") : "";
  const changelog = existsSync(changelogPath)
    ? readFileSync(changelogPath, "utf8")
    : "";

  const html = renderBrief({
    slug: input.slug,
    spec,
    tldr,
    changelog,
    state,
    now: input.now,
  });

  const outPath = resolveOutPath(input);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, "utf8");
  out.push(`wrote ${path.relative(input.cwd, outPath)}.`);

  if (input.noNojekyll !== true) {
    const nojekyll = path.join(input.cwd, ".nojekyll");
    if (!existsSync(nojekyll)) {
      const fd = openSync(nojekyll, "w");
      closeSync(fd);
      out.push(
        `created ${path.relative(input.cwd, nojekyll)} ` +
          `(GitHub Pages compatibility).`,
      );
    }
  }

  out.push(
    `brief is a summarized derivative of SPEC.md. Commit it to publish via ` +
      `Pages: \`git add ${path.relative(input.cwd, outPath)}` +
      (input.noNojekyll === true ? "" : " .nojekyll") +
      ` && git commit\`.`,
  );

  return finish(0, out, err);
}

// ---------- helpers ----------

function resolveOutPath(input: BriefInput): string {
  if (input.out !== undefined && input.out.trim() !== "") {
    return path.isAbsolute(input.out)
      ? input.out
      : path.resolve(input.cwd, input.out);
  }
  return briefHtmlPath(input.cwd, input.slug);
}

function finish(
  exitCode: number,
  outLines: readonly string[],
  errLines: readonly string[],
): BriefResult {
  return {
    exitCode,
    stdout: outLines.length > 0 ? `${outLines.join("\n")}\n` : "",
    stderr: errLines.length > 0 ? `${errLines.join("\n")}\n` : "",
  };
}
