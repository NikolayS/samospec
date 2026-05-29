# CLAUDE.md — SamoSpec

## Project

samospec — git-native CLI (`samospec`) that turns a rough idea into a reviewed, versioned specification document through a lead AI expert and a panel of reviewer experts, with every material step captured in git. Repo: NikolayS/samospec.

See `.samo/blueprints/SPEC.md` for the full specification.

## Naming

- `samospec` — always lowercase (binary name, repo/package name, config keys, prose)
- `SamoSpec` — the product name in titles and user-facing copy
- No middle `spec` in subcommands: `samospec new`, `samospec resume`, `samospec publish` (not `samospec spec new`)
- Config directory: `.samo/`. Branch prefix: `samospec/<slug>`.

## Stack

- **Language:** TypeScript on Bun
- **Distribution:** single binary via `bun build --compile` (Linux + macOS)
- **Subprocess:** `Bun.spawn` for orchestrating AI CLIs (`claude`, `codex`, later `opencode`, `gemini`)
- **Schema validation:** Zod for structured-output contracts
- **Tests:** Bun's built-in test runner; `fast-check` for property-based tests

Not a Postgres project — SQL rules from sibling repos do not apply.

## Engineering standards

Follow the shared rules at https://gitlab.com/postgres-ai/rules/-/tree/main/rules — always pull latest before starting work. Key rules that apply here:

### Git commits

- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `spec:`, `ops:`
- Scope encouraged: `feat(adapter): add codex schema validation`
- Subject < 50 chars, body lines < 72 chars, present tense ("add" not "added")
- **Never amend** — create new commits
- **Never force-push** unless explicitly confirmed
- Never skip hooks (`--no-verify`) unless explicitly confirmed

### Shell scripts (for build / fixture regeneration)

Every script starts with:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'
```

- 2-space indent, no tabs
- 80-char line limit
- Quote all variable expansions; prefer `${var}` over `$var`
- `[[ ]]` over `[ ]`, `$(command)` over backticks
- `lower_case` functions and variables, `UPPER_CASE` for constants
- Scripts with functions have `main()` at bottom, last line `main "$@"`

### Markdown

- **Lists must use `- ` at the start of every list item** (not bare lines, not `*`, not numbered unless order matters). Plain paragraph lines without blank separation or `- ` bullets render as one flowing paragraph — this is the most common source of broken-looking spec metadata headers. Check any block of one-liner facts (version/status/scope, key/value pairs) renders as a list.
- Headings: `#` for title, `##` for top-level sections, `###` for subsections. No skipping levels.
- Code fences: always specify language (` ```ts`, ` ```bash`, ` ```json`). No bare ` ``` `.
- Tables: pipe-delimited with a header separator row; no trailing whitespace.
- ISO 8601 dates everywhere: `yyyy-mm-dd` in prose, `yyyy-mm-ddThh:mm:ssZ` for timestamps.
- Binary units in reports: GiB / MiB / KiB (not GB / MB / KB).

### Security

- **Never put real API keys, tokens, or secrets** in code, comments, commits, issues, PRs, or committed transcripts. Not even for testing or demo.
- Secrets belong in environment variables or `~/.config/samospec/` — never in the repo.
- If a key is accidentally exposed, rotate it immediately and delete/minimize the comment.
- `.samo/spec/<slug>/transcripts/` is **not committed by default** (see SPEC §9) and runs through a redaction pass even when opted in. Do not bypass the redaction pass.
- Hard-coded no-read list for credential files (see SPEC §7 context) cannot be overridden.

## Red-green TDD

All new code lands as: **failing test → minimum green → refactor**. Specific red-first targets are listed in SPEC §13. The phase machine, round state machine, and adapter contract each have a property-based or contract test suite; add to those before shipping related features.

## Model policy (reminder)

Lead and reviewers run on the **strongest, latest model from each vendor** — that part of the thesis is fixed. Reasoning **effort defaults to `high`** (deep, strong review out of the box). Change it explicitly with **`--effort <max|high|medium|low|off>`** (or per-seat `adapters.<seat>.effort` in config): `--effort max` for the deepest review, lower levels to trade depth for speed. In an interactive terminal with no flag/config pin, samospec prompts once for the level with per-level ETAs. See SPEC §11. The `--effort` flag is passed to every `claude` work-call spawn, so the Claude CLI must be **≥ v2.1.0** (`CLAUDE_MIN_EFFORT_VERSION`); `samospec doctor` WARNs when the installed `claude` predates it.

## PR workflow

A PR moves through this lifecycle. **Loop back to step 1 on any failure** — fix the blocking issue, then re-run all subsequent steps.

1. **CI green** — all GitHub Actions checks pass.
2. **REV review** — https://gitlab.com/postgres-ai/rev/ ; fetch diff with `gh pr diff <n>`, run review agents (security, bugs, tests, guidelines, docs), post report as a PR comment. Only NON-BLOCKING / POTENTIAL / INFO findings = **pass**. SOC2 findings (missing reviewer / linked issue) are not blocking for this project — ignore them.
3. **Manual testing** — exercise the change end-to-end where it makes sense (any user-visible feature, any new CLI command, any change touching real I/O). Capture evidence (commands run, stdout/stderr excerpts, screenshots for visual output, file diffs for written artifacts) and post it as a PR comment. The brief feature, new commands, doctor checks, lifecycle gates etc. always need manual evidence; pure refactors and internal helpers may be exempted with a one-line "no manual surface — covered by tests" note.
4. **Approval** — when steps 1–3 all pass, the PR is "ready for owner review". Post a "ready for owner approval" comment summarizing the result. **Never merge without explicit approval from the project owner**, even when steps 1–3 are green.
5. **Merge** — only after explicit owner approval. Squash merge: `gh pr merge <n> --squash`.

If REV finds BLOCKING issues, or manual testing surfaces a regression, fix them and loop back to step 1 (CI re-runs on the new commit, REV re-reviews the new diff, manual evidence is re-captured).

## Release checklist

On every tagged release, run the bump script first to keep package.json and
the git tag in sync:

```bash
bun run scripts/bump-version.ts <version>
# e.g. bun run scripts/bump-version.ts 0.3.0
```

This updates `package.json` and scaffolds a CHANGELOG entry. Then:

1. Fill in the CHANGELOG entry (Added / Fixed / Changed).
2. Update any `vX.Y.Z` references in `README.md`.
3. Commit: `chore: bump version to X.Y.Z`. Tag on `main` after the PR merges.
4. Cut the GitHub Release — this triggers `.github/workflows/publish.yml`:

   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /tmp/release-notes.md
   ```

   The workflow verifies `package.json` version == tag, runs lint/format/typecheck/tests, and publishes to npm with provenance (`npm publish --access public --provenance`). `NPM_TOKEN` lives in GitHub Actions secrets.

## Copyright

Copyright 2026 Nikolay Samokhvalov. Always `Copyright 2026` — never a year range like `2024-2026`.
