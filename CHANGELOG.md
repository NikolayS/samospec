# Changelog

All notable changes to SamoSpec are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
