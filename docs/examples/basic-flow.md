# Basic flow: new → iterate → publish

Copyright 2026 Nikolay Samokhvalov.

This walkthrough shows the full `samospec` lifecycle for a new feature spec.
Output shown is representative; real AI output varies.

## 1. Initialise

```bash
cd /path/to/your-repo
samospec init
```

Output:

```
samospec: initialised .samo/ in /path/to/your-repo.
Run `samospec doctor` to verify the environment.
```

## 2. Doctor check

```bash
samospec doctor
```

Output (healthy setup):

```
OK  availability   claude v1.2.3 at /usr/local/bin/claude; codex v0.9.1 at /usr/local/bin/codex
OK  auth           claude: authenticated (user@example.com); codex: authenticated (user@example.com)
OK  git            branch feature/my-work; remote: git@github.com:org/repo.git
OK  lock           no .samo/.lock file — no concurrent session
OK  config         .samo/config.json valid; pinned models match release metadata
OK  global-config  no global vendor-config files detected
WARN entropy       best-effort entropy check only — run an external scanner for sensitive repos
WARN push-consent  origin (git@github.com:org/repo.git): NOT YET PROMPTED
WARN calibration   sample_count: 0 — first runs; estimate is approximate
OK  pr-capability  PR creation available via gh

samospec doctor: passes with warnings.
```

The WARN entries above are expected on a first run.

## 3. New spec

```bash
samospec new payment-refunds --idea "Marketplace sellers need partial refund issuance"
```

SamoSpec runs through four steps:

### 3a. Persona proposal

```
samospec: lead proposes persona:

  Veteran "marketplace payments engineer" expert

Accept [a], edit [e], or replace [r]? a
```

### 3b. Strategic interview

```
samospec: lead asks 5 strategic questions.

Q1: What payment providers need to be supported in v1?
  1. Stripe only
  2. Stripe + PayPal
  3. All major providers
  d. Decide for me
  s. Not sure — defer
  c. Custom answer

Your choice: 1

Q2: Should partial refunds require seller approval before processing?
  1. Yes — seller must approve each refund
  2. No — auto-approve up to a threshold
  d. Decide for me
  ...
```

### 3c. Draft

```
samospec: lead drafting v0.1 ... done.
samospec: committed spec(payment-refunds): draft v0.1

Push to origin? [accept/refuse] (first push in this repo)
  Remote: git@github.com:org/repo.git
  Branch: samospec/payment-refunds → main
  PR creation available via gh.
accept

samospec: pushed to origin.

TL;DR — payment-refunds v0.1
Goal: Enable marketplace sellers to issue partial refunds.
...

Run `samospec iterate payment-refunds` to start the review loop.
```

## 4. Iterate

```bash
samospec iterate payment-refunds
```

```
samospec: round 1 starting (v0.1 → v0.2)
  reviewer-a (security/ops): running...
  reviewer-b (QA/testability): running...
  both reviews collected.
  lead ingesting reviews and revising...
  committed spec(payment-refunds): refine v0.2

Round 1 cost summary: ~$0.84 (approx; calibration: 0 prior runs).
Lead: 1 finding accepted, 0 rejected, 1 deferred.
Lead signals: not ready yet.

samospec: round 2 starting (v0.2 → v0.3)
  ...
  committed spec(payment-refunds): refine v0.3

Round 2 cost summary: ~$0.72.
Lead: 2 accepted, 1 rejected, 0 deferred.
Lead signals: ready.

samospec: lead is ready after 2 rounds. Stop iterating? [y/n] y
```

## 5. Publish

```bash
samospec publish payment-refunds
```

```
samospec: publish lint — 0 hard warnings, 2 soft warnings.
  soft: unknown command `curl` in shell fence (line 47)
  soft: ghost branch reference: feature/refunds-v2 (line 89)

committed spec(payment-refunds): publish v0.3
pushed to origin.
PR opened via gh: https://github.com/org/repo/pull/42

Blueprint: blueprints/payment-refunds/SPEC.md
```

## Summary

- Total time: approximately 15-25 minutes depending on AI response latency.
- Commits: 4 (init, v0.1 draft, v0.2 refine, v0.3 publish).
- Files created under `.samo/spec/payment-refunds/`:
  - `SPEC.md`, `TLDR.md`, `state.json`, `context.json`
  - `interview.json`, `decisions.md`, `changelog.md`
  - `reviews/r01/round.json` + critiques
  - `reviews/r02/round.json` + critiques
