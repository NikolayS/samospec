# Changelog

All notable changes to SamoSpec are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Fixed

- **iterate: lead revise per-call timeout + whole-round retry (#92):**
  the lead's `revise()` call now has a hard outer deadline enforced at
  the round-runner level. When revise exceeds the configured timeout
  (default 600 s, override via `budget.max_revise_call_ms` in
  `.samo/config.json` or `--rounds` caller), the round runner cancels,
  re-runs reviewers, and calls revise once more. A second timeout
  surfaces as `lead_terminal` (exit 4) with
  `state.json.exit.reason = "lead-terminal:revise_timeout"` and a
  distinct exit-4 message so `samospec status` can tell a stuck revise
  from a generic adapter error. Observed live on `todo-stream` r07 —
  25+ minutes hung before SIGKILL; now capped at `2 × timeout`.

---

## [0.5.0] - 2026-04-22

### Added

- **Architecture schema + ASCII diagram (#107 / #109):** every spec now
  ships a machine-readable `.samo/spec/<slug>/architecture.json`
  (Zod-validated; `version: "1"`, nodes / edges / groups / notes)
  alongside SPEC.md, and an auto-rendered ASCII diagram embedded
  between `<!-- architecture:begin -->` / `<!-- architecture:end -->`
  sentinels inside SPEC.md. The renderer is deterministic, capped at
  80 cols hard and ~40 lines soft (sibling groups collapse to
  `[N label]` when the soft cap trips), and zero-node schemas render
  a `(architecture not yet specified)` placeholder. `new` / `iterate`
  / `resume` all maintain architecture.json and re-render the SPEC.md
  block from it each round.
- **Progress + heartbeat during `iterate` (#101 / #104):**
  `samospec iterate` now emits a human-readable progress stream on stderr —
  round-start, per-phase start/complete with adapter identity + duration,
  and a heartbeat line every ~30 s for each active child (so long
  phases no longer look frozen). Stdout unchanged so scripts parsing
  the final-summary lines keep working. New `--quiet` flag suppresses
  progress + heartbeat; the final summary still lands on stdout.
- **npm publish workflow (#108):** `.github/workflows/publish.yml`
  triggers on GitHub Release publish (or manual `workflow_dispatch`
  with an explicit tag), verifies `package.json` version matches the
  tag, re-runs the CI gate (lint / format / typecheck / tests), then
  `npm publish --access public`. Release flow documented in
  `CLAUDE.md`. `--provenance` is deferred until a trusted-publisher
  config is set up on npmjs (tracked as a follow-up).

### Fixed

- **state.json bookkeeping after round commits (#102 / #105):** iterate
  now opens a small `spec(<slug>): finalize round N` follow-up commit
  so the working tree is clean on exit — including `lead_terminal`
  exit-4 and `push-consent-interrupted` exit-3 paths. A shared
  `finalizeBookkeeping` helper routes all terminal paths through the
  same flow. `state.head_sha` is populated with a reachable 40-char
  SHA (equals HEAD when no finalize follow-up commit was opened,
  HEAD~1 when it was) instead of `null`. `state.updated_at` tracks
  wall-clock via a central `nowIso()` helper rather than the frozen
  round-start timestamp. `verifyHeadSha` accepts both shapes.
- **Real `round.json` `started_at` / `completed_at` (#100 / #103):**
  timestamps are now captured at the actual round boundaries (start
  when the round begins, complete after the revise commit lands),
  not the invocation-time stamps that previously collapsed to the
  same instant.
- **Auto-commit the initial draft on `samospec new` (#94 / #99):**
  `new` used to leave the v0.1 draft staged-but-uncommitted in some
  phase orderings, so the immediately-following `iterate` hit the
  uncommitted-edits guard. The draft now commits cleanly as
  `spec(<slug>): draft v0.1` on every `new` path.
- **Unified next-action across `status` / `tldr` / `iterate` (#96 /
  #98):** the three commands previously emitted slightly different
  next-step phrasings for the same phase + round state. Consolidated
  into one `computeNextAction(state)` helper used by all three; every
  phase+round state transition has an assertion test.
- **Substitute finding IDs in `decisions.md` (#95 / #97):** template
  placeholders like `{{finding_id}}` persisted in committed
  decisions.md entries instead of the real IDs (`rA.3.missing-risk`,
  etc.). The template interpolation now runs at emit time.

### Changed

- **License → Apache-2.0 (#106):** `LICENSE` file added (verbatim
  canonical text); `package.json` `license` flipped from `UNLICENSED`
  to `Apache-2.0` and the `LICENSE` ships in the npm tarball.
- **README rewrite (#106):** live demo link, panel-architecture ASCII
  diagram, safety model, full command table, OAuth-first auth,
  deferred items rescoped from v0.1.0 to v1.1+. Badges (CI / npm /
  license / Bun).

### Known limitations

- Architecture schema + ASCII diagram shipped (#107 / #109); the lead
  adapter does not yet populate `architecture.json`, so all specs
  produced by this release render the
  `(architecture not yet specified)` placeholder until the
  lead-prompt enrichment lands.

---

## [0.4.1] - 2026-04-21

### Fixed

- **Codex pinned-model fallback under ChatGPT-auth (#88):** `gpt-5.1-codex-max`
  returns `exit 1` with an `invalid_request_error` JSON on stdout when
  rejected under ChatGPT-account auth. The adapter used to call
  `classifyExit(exitCode, stderr)` first and the empty stderr yielded
  "other", so the account-default fallback chain never fired. Fix scans
  stdout AND stderr for the error signature before classifying exit —
  stdout-carried error JSON wins regardless of exit code. Also adds
  `"not supported"` to the unavailable-phrase list.
- **Codex agentic-wrapper output parser (#88):** codex v0.120+ emits an
  agentic banner followed by `codex\n<JSON>\ntokens used…`. The legacy
  extractor matched the literal `codex\n` prefix anywhere and produced a
  partial JSON fragment, failing with `schema_violation`. Now requires the
  next non-blank line after `codex\n` to start with `{`, guarded against
  stray `codex` tokens inside the wrapped content.

---

## [0.4.0] - 2026-04-21

### Added

- **Idea precedence over slug cues (#85):** lead and reviewer prompts now
  include an AUTHORITATIVE idea framing block ahead of any slug-derived
  hint. Fixes a failure mode where e.g. a slug `todo-stream` made Claude
  draft a CRUD todo app despite an explicit "NOT a CRUD app" clarifier in
  `--idea`.
- **Reviewer B contradiction detection (#85):** when an idea is present,
  Reviewer B's critique prompt receives a contradiction-detection directive
  that flags any section of the revised spec that deviates from the
  original idea.

---

## [0.3.1] - 2026-04-21

### Fixed

- **Bun spawn hang on SIGKILL (#81):** `new Response(stream).text()` blocks
  waiting for EOF even after `SIGKILL`, so `spawnCli` never resolved on
  timeout (observed live: a 22+ minute hang). Fix uses an `AbortController`
  with a manual `ReadableStream` reader and `Promise.race` so the stream
  read unblocks within `timeoutMs` of the kill signal.
- **Per-call timeout + session wall-clock in `runNew` (#83):** the session
  wall-clock budget is now honored on every `ask`/`revise` call — each is
  wrapped in `withDeadline()` against the session deadline, so a hung
  adapter can no longer pin the full session. On cap, `runNew` exits 4
  with `session-wall-clock` in stderr.

---

## [0.3.0] - 2026-04-21

### Added

- **Auto-init git + empty commit (#72 / #65):** first `samospec init` in
  a non-git or empty-HEAD directory either prompts or (`--yes`)
  auto-creates `.git/` plus an initial empty commit.
- **Next-step hints everywhere (#71):** `samospec resume <slug>` prints
  `next: samospec iterate <slug>` or `next: samospec publish <slug>`
  depending on phase. `samospec iterate` prints
  `next: samospec publish <slug>` on success stops and recovery
  guidance on failure stops.
- **`--force` archive naming matches SPEC §10 (#69):**
  `.samo/spec/<slug>.archived-YYYY-MM-DDThhmmssZ/` (ISO 8601 UTC, no
  colons so it's Windows-portable, with `-1` / `-2` collision suffix on
  same-second runs). Was `.bak.<ts>` in v0.2.0.
- **`scripts/bump-version.ts` (#57):** release-prep script that bumps
  `package.json` and scaffolds a CHANGELOG entry. Prevents the tag /
  `package.json` drift that caused v0.1.0 / v0.1.1 mismatches.

### Fixed

- **Reviewer-failure convergence guard (#64):** when both reviewers fail
  in a round, the lead's `ready=true` is no longer silently accepted.
  `reviewers-exhausted` is now the dominant stopping reason over `ready`
  / `semantic-convergence`. Prevents shipping an un-reviewed v0.N spec.
- **Codex preflight label under OAuth (#70 / #80):** under ChatGPT OAuth
  (no `OPENAI_API_KEY`), reviewer_a preflight cost now reads
  `unknown — OAuth (no per-token cost visibility)` instead of a
  misleading dollar figure. Wired end-to-end through `runPreflight`.
- **`--force` on existing slug dir (#63 / #68):** `samospec new --force`
  was silently ignored when the slug dir already existed. Now archives
  the existing dir and proceeds.
- **`samospec publish` base-branch push (#67):** `gh pr create` failed
  when local `main` had not been pushed to the remote. Now pushes the
  base branch first.
- **`samospec init --yes` on non-git dirs (#79):** `runInitCommand` was
  discarding `--yes`, so auto-git-init never fired from the CLI path.

---

## [0.1.1] - 2026-04-20

### Fixed

- **Codex under ChatGPT-account auth (#54 / #55):** the pinned models
  `gpt-5.1-codex-max` / `gpt-5.1-codex` are not available on ChatGPT
  subscription accounts, so v0.1.0 exhausted the fallback chain and left
  Reviewer A failing every round. v0.1.1 adds an implicit account-default
  tier after the explicit pins (one more call with `--model` omitted),
  correctly classifies codex's exit-0 `invalid_request_error` stdout JSON
  as `model_unavailable` instead of `schema_violation`, and lists every
  attempted tier in the terminal error message. New opt-out:
  `codex.accountDefaultFallback: false`.

---

## [0.2.0] - 2026-04-20

### Added

- **Baseline SPEC.md section template (#58):** every generated spec now
  includes nine mandatory sections by default: version header, goal &
  why, user stories (≥3), architecture, implementation details, tests
  plan with red/green TDD, team of veteran experts, implementation plan
  with sprints, and embedded changelog. Pass `--skip <list>` to opt out
  of specific sections. `buildRevisePrompt` and `buildAskPrompt` are
  now exported for tests.
- **Structured decisions array on `revise()` (#59):** `ReviseOutput` gains an
  optional `decisions[]` field (verdict: accepted/rejected/deferred). When
  present, the loop serializes it to `decisions.md` with per-round headers and
  updates `changelog.md` with real accepted/rejected/deferred counts. When
  absent, falls back to "no decisions recorded this round" (backward compat).
- `buildBaselineSectionsBlock()` helper exported from `claude.ts`.
- `ReviseDecisionSchema`, `ReviseDecision`, `BASELINE_SECTION_NAMES`,
  `BaselineSectionName` exported from `schemas.ts` / `types.ts`.
- `reviseDecisionsToReviewDecisions()` helper in `decisions.ts`.

### Changed

- **Reviewer B persona (#58):** system prompt now explicitly instructs
  Reviewer B to raise `missing-requirement` findings for any missing
  mandatory baseline section.
- **Round decision extraction (#59):** `runRound` prefers
  `revised.decisions` array (v0.2.0+) over the legacy
  `extractDecisions(rationale, spec)` path.

### Fixed

- **Stale scaffolding text (#60):** removed "review loop lands in
  Sprint 3" and "--no-push default active; push consent gate ships in
  Sprint 3" from `samospec new` stdout. Replaced with accurate
  next-step hint: `samospec iterate <slug>` or `samospec resume <slug>`.
  Same cleanup in `samospec resume` happy-path output.
- `decisions.md` seed no longer contains "Populated during Sprint 3".
- **Codex ChatGPT-account auth (#54):** three tangled bugs fixed together.
  (1) Exit-0 stdout `invalid_request_error` JSON (the real shape Codex emits
  when a pinned model is unsupported under ChatGPT-account auth) was
  misclassified as `schema_violation`; now correctly classified as
  `model_unavailable` via a pre-parse stdout check.
  (2) After both explicit pins (`gpt-5.1-codex-max`, `gpt-5.1-codex`) fail
  with `model_unavailable`, the adapter now attempts one final call with
  `--model` omitted (account-default tier), letting codex pick the
  account's supported model. On success, `AskOutput.account_default: true`
  is set and `samospec status` surfaces the degraded resolution.
  (3) When all three tiers fail, the terminal error detail lists every
  attempted tier for diagnosis.
  New config key: `adapters.reviewer_a.account_default_fallback` (default
  `true`); set to `false` to force explicit-pin-only mode.
- **OAuth is the primary auth mode** (#48): reverts PR #47's architectural
  error. `claude /login` OAuth sessions are now fully supported for
  non-interactive work calls — no `ANTHROPIC_API_KEY` required. Stale env
  vars preempt OAuth; `samospec doctor` warns with unset guidance.
- Preflight cost label for OAuth adapters changed from
  `unknown — subscription auth (API key required)` to
  `unknown — OAuth (no per-token cost visibility)`.
- Doctor auth check now runs a live probe (`echo "probe" | claude -p`)
  and classifies the result: OK on success, WARN with specific guidance on
  `Invalid API key` (stale env var), not-authenticated (run `claude /login`),
  or other failure (generic message).
- SPEC §11 rewritten: OAuth is primary; API key is alternative; §18 open
  question refined to per-call token visibility (not whether non-interactive
  works at all).

---

## [0.1.0] - 2026-04-19

First public release. v1.0 feature set per `.samo/blueprints/SPEC.md`.

### Added

- `samospec init` — initialise `.samo/` config directory in any git repo
  (SPEC §5 Phase 1, §10).
- `samospec new <slug> --idea "..."` — lead persona proposal, five-question
  strategic interview, v0.1 draft commit on `samospec/<slug>` branch
  (SPEC §5 Phases 2-5).
- `samospec iterate [<slug>]` — review loop: Reviewer A (Codex, security/ops
  persona) and Reviewer B (Claude, QA/testability persona) in parallel; lead
  revision; version bump; convergence detection via trigram-Jaccard (§12).
- `samospec publish <slug>` — promote SPEC.md to `blueprints/<slug>/SPEC.md`,
  commit, consent-gated push, PR via `gh`/`glab` (SPEC §5 Phase 7).
- `samospec resume [<slug>]` — resume a paused session from last committed
  round state; offline and non-fast-forward paths handled (SPEC §8).
- `samospec status [<slug>]` — print phase, round, version, exit reason, and
  push-consent summary (SPEC §10).
- `samospec doctor` — full environment check: CLI availability, auth (including
  subscription-auth escape per §11), git health, lockfile, config sanity,
  entropy scan, global-config contamination (§14), push-consent per remote,
  calibration state, PR-open capability.
- Publish lint (SPEC §14): hard warnings for missing file paths; soft warnings
  for unknown commands, ghost branches, and adapter/model drift.
- First-push consent flow: per-repo, per-remote-URL, persisted in
  `.samo/config.json` (SPEC §8).
- Preflight cost estimate: calibrated from prior sessions, shown before any
  paid lead call (SPEC §11).
- Dogfood scorecard test (`tests/dogfood/scorecard.test.ts`): 5-criterion
  version-agnostic check against frozen template (SPEC §13 item 11, §17).
- Subscription-auth escape: wall-clock + iteration caps replace token budgets
  when Claude Max/Pro cannot report usage (SPEC §11).
- Entropy scan (best-effort) + global-config contamination detection in doctor.

### Distribution

- npm package: `bunx samospec` or `bun install -g samospec`.
- Requires Bun >= 1.2.0. `npx` not supported in v0.1.0.
- Source: https://github.com/NikolayS/samospec

### Not in v0.1.0 (deferred)

- Homebrew / apt / standalone binary.
- Gemini and OpenCode adapters.
- Non-software persona packs.
- `samospec compare`, `samospec diff`, `samospec export`.
- `samospec experts set` — edit `.samo/config.json` manually.
- Weekly live CI workflow against real CLIs (TODO, post-v0.1).
