# SamoSpec — security notes

Copyright 2026 Nikolay Samokhvalov.

SamoSpec runs multiple CLI-driven AI agents against a repo. This page
describes what the redaction corpus and the `samospec doctor` entropy
check do — and, more importantly, what they **don't** do. See SPEC §9,
§14, and §18 for the authoritative details.

## What redaction covers

The `redact()` function in `src/security/redact.ts` walks the corpus in
`src/security/patterns.ts` and replaces every match with a tag of the
form `<redacted:kind>`. The current corpus (SPEC §9) covers:

- AWS access key IDs: `AKIA...`, `ASIA...`
- OpenAI API keys: `sk-...` and `sk-proj-...`
- Stripe keys: `sk_live_...`, `sk_test_...`
- GitHub tokens: `ghp_...`, `gho_...`, `ghs_...`
- GitLab personal access tokens: `glpat-...`
- JWTs (tightened): `eyJ...` plus two further base64url segments,
  each at least 10 characters. Deliberately narrower than the naive
  `X.Y.Z` shape so spec prose like `v1.2.3`, `foo.bar.baz`, and
  `example.com.au` passes through unchanged.
- Slack tokens: `xox[bpoar]-...`
- Google API keys: `AIza...`

Replacement is idempotent: running `redact()` on already-redacted text
is a no-op because the placeholder does not match any rule.

Sprint 3 wires `redact()` into the transcript-writing path. Until then,
the function is exercised by tests and by the `doctor` entropy check.

## What redaction does NOT cover

SPEC §18 lists the non-goals. The two most important:

- **`context.json` file paths.** Paths the lead agent chose as discovery
  targets are stored verbatim; they may reveal directory structure but
  no entry in the hard-coded no-read list (SPEC §7) is ever admitted to
  `context.json`.
- **`decisions.md` user prose.** Manual-edit capture preserves the
  user's own wording. Applying `redact()` there could quietly corrupt
  rationale text, so this is opt-out rather than opt-in. Users who want
  stricter hygiene should run an external scanner on the committed
  artefacts before pushing (see below).

Neither set of files is covered in v1. The roadmap in SPEC §18 tracks
the open question for post-v1.

## `samospec doctor` entropy check

`doctor` runs a best-effort sweep across:

- `.samospec/spec/<slug>/transcripts/*.log` (written by Sprint 3)
- any file listed under `doctor.entropy_scan_paths` in
  `.samospec/config.json`
- explicit paths the caller passes via the `extraPaths` argument
  (used by tests)

The check reports a hit count and a file count. It **never** prints the
matched content — only the counts and the canonical warning:

> entropy scan is best-effort; recommend external scanners
> (gitleaks, truffleHog) for sensitive repos

The severity contract:

- **OK** — at least one file was scanned and came back clean
- **WARN** — hits were found OR nothing has been written yet to scan
- **FAIL** — never. The entropy check is diagnostic, not a gate. A
  FAIL here would be a harness bug.

## External scanners

For sensitive repos, run a real scanner in addition to the `doctor`
check. SamoSpec does not shell out to these; the recommendation is
explicit and repeated:

- [`gitleaks`](https://github.com/gitleaks/gitleaks) — pre-commit hook
  or CI step.
- [`trufflehog`](https://github.com/trufflesecurity/trufflehog) — also
  usable in CI; has higher-quality rulesets for cloud provider keys.

Both support `.samospec/`-scoped scans.

## Reporting a secret leak

If a real credential lands in a commit:

1. Rotate the key immediately at the issuing provider.
2. Remove the commit from history and force-push (coordinate with
   everyone who has the branch checked out).
3. Open a redaction-corpus issue only if the regex shape would have
   caught it — that's a signal our corpus drifted.

Do **not** open a public issue or PR that quotes the leaked value. Talk
to the repo owner first.
