# Changelog

## [0.3.1] - 2026-04-21

### Added

- (describe additions)

### Fixed

- (describe fixes)

### Changed

- (describe changes)

## [0.3.0] - 2026-04-21

### Added

- (describe additions)

### Fixed

- (describe fixes)

### Changed

- (describe changes)

All notable changes to SamoSpec are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

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
