# SamoSpec

Version: 0.1

## Goal

Create a git-native CLI for multi-AI spec creation and iterative refinement.

The tool helps a user turn an idea into a strong, versioned `SPEC.md` using:
- one lead AI expert
- optional review experts
- git commits after each material change

Primary use case:
- software/product specs

Secondary use cases:
- broader strategic/operational specs

## Why it's needed

People can generate first-draft specs quickly with AI, but:
- first drafts are usually shallow
- model output is inconsistent
- iterative refinement is messy
- reviews are lost in chat
- decisions are not versioned
- there is no clean git-native loop

This CLI makes spec creation:
- structured
- iterative
- reviewable
- reproducible
- stored in git

## Key product idea

Use a **lead expert** to author the spec and **review experts** to critique it.

The lead expert owns:
- questioning the user
- writing `SPEC.md`
- deciding which review feedback to accept

Review experts:
- critique
- find ambiguity, contradictions, missing cases, weak tests, weak planning
- do not directly own the main spec

## Core workflow

### Step 0 — assumptions
Assume these CLIs may be installed and authenticated:
- Claude Code
- Codex
- OpenCode (optional)
- Gemini CLI / equivalent (optional, off by default unless explicitly enabled)

### Step 1 — input idea
User provides:
- a new idea
- or an existing repo/context
- or an existing partial spec

Possible contexts:
- existing GitHub/GitLab repo with code
- fresh repo with no code
- standalone local git repo

### Step 2 — choose lead expert
Default:
- Claude infers recommended lead expert

User sees:
> Your assistant is: Veteran `"software engineer"` expert

User can:
- confirm
- refine
- replace with another quoted skill

Examples:
- Veteran `"software engineer"` expert
- Veteran `"online marketing"` expert
- Veteran `"product manager"` expert
- Veteran `"data platform architect"` expert

### Step 3 — strategic questioning
Lead expert asks up to **5 strategic questions**.

Questions should be:
- high-signal
- mostly multiple-choice
- minimal but enough to shape the spec

Each question supports:
- standard choices
- **decide for me**
- **not sure / decide during implementation**
- **custom answer**

### Step 4 — create v0.1 spec
Lead expert creates:
- `./blueprints/<feature-name>/SPEC.md`

Immediately commits it to git.

Initial spec includes:
- goal and why it’s needed
- a few user stories
- architecture
- implementation details
- CI/tests and red/green TDD plan
- expert team to hire
- sprint-based implementation plan
- version `0.1`
- changelog

### Step 5 — human checkpoint
User sees:
- spec path
- TL;DR summary
- option to:
  - review/edit manually
  - run auto-refinement

### Step 6 — automated refinement
If enabled:
- choose `N` review experts, default `2`
- choose max `M` iterations, default `10`

Default review experts:
- Claude strongest available model
- GPT strongest available model

Optional:
- OpenCode
- Gemini (off by default unless explicitly enabled / budget-approved)

Loop:
1. reviewers review current spec
2. lead expert reads reviews
3. lead updates spec
4. bump version + changelog
5. commit to git
6. repeat until:
   - `M` reached
   - or convergence
   - or lead marks ready

### Step 7 — present result
Show:
- final TL;DR
- current version
- key unresolved questions
- next action options:
  - manual refine
  - more review rounds
  - implementation planning
  - export/share

## User stories

### Story 1 — new software idea
As a developer, I want to describe a rough idea and get a proper `SPEC.md` in git, so I can move into implementation without hand-writing the whole thing from scratch.

### Story 2 — existing repo
As a maintainer, I want to generate a spec in the context of an existing repo, so the spec reflects real codebase constraints.

### Story 3 — multi-model review
As a spec owner, I want multiple AI reviewers to critique a draft, so blind spots are caught before implementation starts.

### Story 4 — human control
As a user, I want to confirm the lead expert and review the result at checkpoints, so the process stays useful and not fully autonomous nonsense.

### Story 5 — audit trail
As a user, I want every material spec revision committed to git, so changes are inspectable and reversible.

## Architecture

### Components
- CLI entrypoint
- repo/context detector
- lead expert selector
- interview/question engine
- spec generator
- review orchestrator
- git commit manager
- TL;DR renderer
- model adapter layer

### Model roles
- **Lead model**: writes and revises the spec
- **Review models**: critique and suggest changes
- **User**: final authority

### Storage
In git:
- `SPEC.md`
- review artifacts
- changelog
- optional decisions file

## Repo/file layout

```text
blueprints/
  <feature-name>/
    SPEC.md
    REVIEWS/
      review-claude-r1.md
      review-codex-r1.md
    DECISIONS.md
```

## Model policy
Default:
- lead = Claude
- reviewers = Claude + GPT
- Gemini disabled by default
- OpenCode optional

Need support for:
- model selection
- tool availability detection
- per-model enable/disable
- budget guardrails
- max iterations
- max reviewer count

## Git behavior
Every material step must be committable.

Recommended commits:
- `spec: create v0.1 for <feature>`
- `spec: refine to v0.2 after review round 1`
- `spec: refine to v0.3 after review round 2`

Possible option:
- dry-run mode with no commit
- default should still encourage real git history

## Stopping conditions
Stop refinement when any of:
- max iterations reached
- lead expert marks ready
- two consecutive rounds produce no substantial improvements
- user interrupts / takes over

## Tests / CI / red-green TDD
Need tests for:

### CLI behavior
- no repo vs existing repo
- empty repo vs populated repo
- missing model tool detection
- invalid user input paths

### Workflow behavior
- lead expert confirmation flow
- max 5 questions
- correct support for “decide for me” / “not sure” / custom answer
- spec file created at correct path
- changelog/version initialized
- review loop respects N and M
- convergence / stop rules work
- git commits happen at expected steps

### Integration tests
- mocked Claude/Codex/OpenCode/Gemini adapters
- deterministic review/refinement loop
- failure handling when one reviewer fails
- Gemini disabled-by-default policy
- budget cap enforcement hooks

### Red/green TDD
Use red/green for:
- workflow-state transitions
- loop stopping logic
- git commit behavior
- multi-review orchestration
- budget guard enforcement

## Expert team to hire
For implementation, I’d hire:
- Veteran `"CLI software engineer"` expert
- Veteran `"AI orchestration engineer"` expert
- Veteran `"UX writer"` expert
- Veteran `"tooling/reliability engineer"` expert
- Veteran `"git workflow"` expert

## Sprint plan

### Sprint 1 — MVP
- CLI skeleton
- detect repo / create blueprint path
- lead expert selection
- up-to-5 interview questions
- generate v0.1 `SPEC.md`
- commit to git

### Sprint 2 — review loop
- review expert orchestration
- version bumping
- changelog updates
- iterative commits
- TL;DR output

### Sprint 3 — model policy / controls
- optional Gemini integration
- budget / reviewer limits
- convergence logic
- failure handling / retries

### Sprint 4 — polish
- cleaner prompts
- review artifact storage
- stronger tests
- docs/examples

Parallelization:
- model adapter layer can be built in parallel with git/layout logic
- review loop can be built in parallel with TL;DR / formatting

## Open questions
- exact CLI name / repo name (`samospec`, `spec.doctor`, etc.)
- command shape
- whether reviews live in git by default
- whether specs are always under `blueprints/`
- exact budget policy for Gemini
- whether OpenCode is first-class or optional plugin

## Changelog

### v0.1
- initial concept spec created
