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

Lead and reviewers run on the **strongest, latest model from each vendor at `effort: max`** — this is the product thesis, not a tunable to dial down by default. Downshifting is a conscious per-invocation flag (`--effort`), never a silent default. See SPEC §11.

## PR workflow

1. **CI green** — all GitHub Actions checks pass.
2. **REV review** — https://gitlab.com/postgres-ai/rev/ ; fetch diff with `gh pr diff <n>`, run review agents (security, bugs, tests, guidelines, docs), post report as a PR comment. Only NON-BLOCKING / POTENTIAL / INFO findings = **pass**.
3. **Merge** — squash merge: `gh pr merge <n> --squash`.

Fix BLOCKING findings before merge, then re-run CI and REV. SOC2 findings (missing reviewer / linked issue) are not blocking for this project.

Never merge without explicit approval from the project owner.

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

## Copyright

Copyright 2026 Nikolay Samokhvalov. Always `Copyright 2026` — never a year range like `2024-2026`.
