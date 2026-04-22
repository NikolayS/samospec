# SamoSpec

[![CI](https://github.com/NikolayS/samospec/actions/workflows/ci.yml/badge.svg)](https://github.com/NikolayS/samospec/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/samospec.svg)](https://www.npmjs.com/package/samospec)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A5_1.2-000?logo=bun)](https://bun.sh)

> Turn a rough idea into a **reviewed, versioned spec** — with every round captured in git, not chat scrollback.

`samospec` is a git-native CLI that runs a small panel of top AI models against your idea: a **lead** drafts, two **reviewers** critique with different personas, the lead revises, and the loop repeats until convergence. The result is `SPEC.md` with real commit history — `v0.1 → v0.2 → … → v1.0` — that you can diff, blame, and publish.

**Live demo** — a real spec produced end-to-end over ChatGPT-account OAuth:
→ https://github.com/NikolayS/todo-stream/tree/samospec/todo-stream
(browse the `.samo/spec/todo-stream/` tree; 7 review rounds, both reviewers writing real critiques)

---

## Why

Most "AI writes my spec" tools give you one shot from one model. You get a monologue in a chat window, lose the context the moment the tab closes, and have no record of what was considered and rejected.

SamoSpec treats spec authoring like code review:

- **Panel, not monologue.** One lead drafts; two reviewers with deliberately different personas critique in parallel. Disagreement is surfaced, not averaged away.
- **Every round is a commit.** Each revision lives on a `samospec/<slug>` branch. `git log` tells the story. `decisions.md` records what was accepted, rejected, or deferred — and why.
- **Convergence is defined, not vibes.** Eight explicit stopping conditions — lead-ready, semantic convergence, repeat-findings halt via trigram Jaccard, wall-clock cap, budget cap, max rounds, reviewers-exhausted, user SIGINT — mean the loop _ends_ on its own.
- **Strongest model, max effort, by default.** No silent downshifting. The thesis is that great specs come from the top of each vendor's ladder running hard, not from the cheapest model running often.

---

## Install

Requires [Bun](https://bun.sh) ≥ 1.2.0.

```bash
bun install -g samospec
samospec --version   # 0.4.1
```

Or one-shot:

```bash
bunx samospec doctor
```

`npx` is not supported — use `bunx` or a global Bun install.

---

## Quickstart

Three commands, from idea to reviewed spec:

```bash
samospec init                                       # scaffolds .samo/ in the current git repo
samospec new linkrot --idea "Detect dead links in Markdown files"
samospec iterate linkrot                            # lead drafts → 2 reviewers critique → lead revises → repeat
samospec publish linkrot                            # promote, commit, push, open PR via gh
```

At every step: `samospec status <slug>` prints phase, current version, next-step hint, and last-round summary.

---

## How it works

```text
                 ┌────────────────────┐
   idea  ──►     │  LEAD  (Claude)    │  ──►   SPEC.md v0.N
                 │  draft / revise    │
                 └────┬───────────────┘
                      │  (parallel)
       ┌──────────────┴──────────────┐
       ▼                             ▼
 ┌──────────────┐             ┌──────────────┐
 │ Reviewer A   │             │ Reviewer B   │
 │ (Codex)      │             │ (Claude #2)  │
 │ security/ops │             │ QA/pedant    │
 └──────┬───────┘             └───────┬──────┘
        │                             │
        └───────┐             ┌───────┘
                ▼             ▼
             ┌──────────────────────┐
             │  round.json          │  ─► commit ─► repeat
             │  claude.md, codex.md │
             │  decisions.md update │
             └──────────────────────┘
```

- **Lead** = `claude` CLI, pinned `claude-opus-4-7`, effort `max`.
- **Reviewer A** = `codex` CLI with a **security/ops** persona: missing risks, weak implementation, unnecessary scope.
- **Reviewer B** = second `claude` session with a **QA / testability** persona: ambiguity, contradiction, weak-testing. Also checks the spec's mandatory baseline sections and verifies it stays faithful to your original idea.
- Adapters share a coupled-fallback rule (lead and Reviewer B use the same vendor, so a Claude outage fails them together rather than running an uneven panel).

Every generated `SPEC.md` gets nine mandatory sections by default (goal & why, user stories, architecture, implementation details, tests plan with red/green TDD, team of veteran experts, sprint plan, embedded changelog, version header). Pass `--skip` to opt out.

Every spec also ships a machine-readable `.samo/spec/<slug>/architecture.json` (Zod-validated; nodes/edges/groups/notes) and an auto-rendered 80-column ASCII diagram embedded in SPEC.md between `<!-- architecture:begin -->` / `<!-- architecture:end -->` sentinels. `iterate` re-renders the block from `architecture.json` on every round, so the diagram stays in lockstep with the schema.

---

## Auth — OAuth is the happy path

The CLI shells out to the vendor CLIs you already use. OAuth-based sessions are the **primary** auth mode — API keys are an alternative:

- **Claude Code** — `claude /login` once in a terminal; samospec inherits the session for `claude --print` calls. Or `export ANTHROPIC_API_KEY=sk-ant-...`.
- **Codex** — `codex auth` (ChatGPT subscription account works); samospec handles the pinned-model fallback when your account default differs. Or `export OPENAI_API_KEY=sk-...`.

```bash
samospec doctor   # verifies CLI availability, auth, git, lockfile, config, entropy, push consent
```

---

## Safety model

- **Never commits to protected branches.** The publish PR targets `main` from a `samospec/<slug>` branch.
- **First-push consent.** `samospec iterate` asks once per remote before pushing; decision persists in `.samo/config.json`.
- **Prompt-injection envelope.** Untrusted content (repo files, review bodies) is wrapped in a content-unique `<repo_content_<sha8> trusted="false">…</repo_content_<sha8>>` frame with a recency-bias suffix reminder, so a hostile README can't hijack the lead.
- **Hard-coded no-read list** for credential files (`.env*`, `~/.aws/credentials`, `~/.ssh/id_*`, …) cannot be overridden.
- **Transcripts not committed by default.** When opted in, they pass a gitleaks/truffleHog-derived redaction pass first.
- **Minimal-env spawn.** Subprocesses see only `HOME`, `PATH`, `TMPDIR`, `USER`, `LOGNAME` plus caller-declared auth vars — no ambient environment bleed.

---

## Commands

| Command                          | What it does                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `samospec init`                  | Scaffolds `.samo/` in the current git repo. Idempotent.                                                                                      |
| `samospec doctor`                | Checks CLI availability, auth, git, lockfile, config, entropy, calibration, push consent, global-vendor-config contamination, PR-capability. |
| `samospec new <slug> --idea "…"` | Starts a new spec: persona selection → five-question strategic interview → drafts v0.1.                                                      |
| `samospec iterate <slug>`        | Runs review rounds (lead + two reviewers in parallel) until a stopping condition fires.                                                      |
| `samospec resume <slug>`         | Idempotent resume from any crash/kill. Works at every round state boundary.                                                                  |
| `samospec status <slug>`         | Phase, version, round index, last-round summary, next-step hint.                                                                             |
| `samospec publish <slug>`        | Promotes spec to `.samo/blueprints/`, commits, pushes, opens PR via `gh` / `glab`.                                                           |

Useful flags:

- `samospec new --skip user-stories,sprint-plan,…` — opt out of baseline sections.
- `samospec new --max-session-wall-clock-ms 1800000` — 30-min session cap.
- `samospec new --force` — archive any existing `<slug>` dir as `.archived-YYYY-MM-DDThhmmssZ/` before starting.
- `samospec iterate --rounds 5` — cap rounds for this invocation.
- `samospec iterate --no-push` — stay local this run.
- `samospec iterate --quiet` — suppress the per-round progress + heartbeat stream on stderr (final summary still prints on stdout).

---

## Stack

- **Language:** TypeScript on Bun
- **Distribution:** npm (Homebrew / apt / standalone binaries — v1.1+)
- **Subprocess:** `Bun.spawn` (minimal env; AbortController-backed stream reader so SIGKILL actually unblocks)
- **Schema validation:** Zod for every structured-output contract
- **Tests:** Bun's built-in runner; `fast-check` for property-based tests on the phase + round state machines

---

## Not in this release (deferred)

- Homebrew, apt, or standalone compiled binaries — planned for v1.1+.
- Gemini and OpenCode adapters — planned for v1.1+. Claude + Codex only today.
- `samospec compare`, `samospec diff`, `samospec export pdf|html` — v1.5+.
- Non-software persona packs (marketing, ops playbooks, research specs) — v1.5+.
- `samospec experts set` — edit `.samo/config.json` manually until v1.1.

See [`.samo/blueprints/SPEC.md`](.samo/blueprints/SPEC.md) for the full product spec (architecture, state machines, adapter contract, publish lint, dogfood scorecard, threat model, implementation plan).

---

## Contributing

- PRs welcome; target `main` from a feature branch.
- Red-green TDD for new code — failing test → minimum green → refactor. Property-based tests for anything touching the phase machine, round state machine, or adapter contract.
- Conventional Commits, 50-char subjects, present tense. Never amend, never force-push without confirmation.
- See [`CLAUDE.md`](CLAUDE.md) for full engineering standards.

Found a bug? https://github.com/NikolayS/samospec/issues

---

## License

Apache-2.0. See [`LICENSE`](LICENSE). Copyright 2026 Nikolay Samokhvalov.
