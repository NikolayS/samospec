# SamoSpec

Version: 0.2

## Goal

Create a git-native CLI for multi-AI spec creation and iterative refinement.

SamoSpec helps a user turn an idea into a strong, versioned spec using:
- one lead AI expert
- optional review experts
- git commits after each material change
- a persistent hidden working area inside the repo

Primary use case:
- software/product specs

Secondary use cases:
- broader strategic, operational, research, marketing, and planning specs

## Product thesis

SamoSpec is **not** just a spec generator.

It is a **git-native spec authoring and review workflow** with:
- one lead expert who owns the draft
- multiple reviewer experts who critique it
- the user as final authority

The system must avoid multi-model consensus mush.
One model owns the draft. Other models review. The lead decides what to accept.

## Why it's needed

People can generate first-draft specs quickly with AI, but:
- first drafts are shallow
- model output is inconsistent
- iterative refinement is messy
- reviews are lost in chat
- decisions are not versioned
- git history is missing
- multiple models often create contradictory mush instead of stronger specs

SamoSpec makes spec creation:
- structured
- iterative
- reviewable
- reproducible
- stored in git
- safe enough for both engineers and non-engineers

## Core workflow

### Step 0 — assumptions
Assume these CLIs may be installed and authenticated:
- Claude Code
- Codex
- OpenCode (optional)
- Gemini CLI / equivalent (optional, disabled by default unless explicitly enabled)

### Step 1 — input idea
User provides:
- a new idea
- or an existing repo/context
- or an existing partial spec

Possible contexts:
- existing GitHub/GitLab repo with code
- fresh repo with no code
- standalone local git repo
- no repo yet (SamoSpec can initialize one)

### Step 2 — choose lead expert
Default behavior:
- Claude infers the recommended lead expert skill

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
- strategic, not implementation trivia

Each question supports:
- standard choices
- **decide for me**
- **not sure / decide during implementation**
- **custom answer**

### Step 4 — create v0.1 spec
Lead expert creates the initial spec.

Working files are stored under:

```text
.samo/spec/
```

Suggested structure:

```text
.samo/
  spec/
    SPEC.md
    TLDR.md
    DECISIONS.md
    REVIEWS/
      review-claude-r1.md
      review-codex-r1.md
```

The initial draft is committed to git immediately.

Initial spec includes:
- goal and why it’s needed
- user stories
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

Default reviewers:
- Claude strongest available model
- GPT strongest available model

Optional reviewers:
- OpenCode
- Gemini (off by default unless explicitly enabled and budget-approved)

Loop:
1. reviewers critique current spec
2. lead expert reads all reviews
3. lead updates spec
4. version bumps + changelog updates
5. commit to git
6. repeat until:
   - `M` reached
   - convergence
   - or lead marks ready for human review

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
As a developer, I want to describe a rough idea and get a proper versioned spec in git, so I can move into implementation without hand-writing the whole thing from scratch.

### Story 2 — existing repo
As a maintainer, I want to generate a spec in the context of an existing repo, so the spec reflects real codebase constraints.

### Story 3 — broad non-software use
As a user, I want to create a strategic or operational spec outside software, so the tool is useful for broader planning work too.

### Story 4 — multi-model review
As a spec owner, I want multiple AI reviewers to critique a draft, so blind spots are caught before implementation starts.

### Story 5 — human control
As a user, I want to confirm the lead expert and review the result at checkpoints, so the process stays useful and not fully autonomous nonsense.

### Story 6 — audit trail
As a user, I want every material revision and review artifact committed to git, so changes are inspectable and reversible.

## Architecture

### Components
- CLI entrypoint
- repo/context detector
- lead expert selector
- interview/question engine
- spec generator
- review orchestrator
- git commit/push manager
- TL;DR renderer
- model adapter layer
- budget/policy guard

### Model roles
- **Lead model**: writes and revises the spec
- **Review models**: critique and suggest changes
- **User**: final authority

### Model adapter contract
Each model adapter should support:
- availability detection
- auth detection
- prompt execution
- structured output mode when possible
- token/cost accounting when available
- failure classification (retryable vs terminal)

Initial adapters:
- Claude Code
- Codex
- OpenCode (optional)
- Gemini (optional, disabled by default)

### Review taxonomy
Reviewers should categorize findings into:
- ambiguity
- contradictions
- missing requirements
- weak testing
- weak implementation details
- missing risks / assumptions
- unnecessary scope

### Storage
In git under `.samo/spec/`:
- `SPEC.md`
- `TLDR.md`
- `DECISIONS.md`
- `REVIEWS/*.md`
- version/changelog history inside the main spec

## Git behavior

### Default behavior
SamoSpec should commit automatically after each material step.

Recommended commits:
- `spec: create v0.1 for <topic>`
- `spec: refine to v0.2 after review round 1`
- `spec: refine to v0.3 after review round 2`

### Push behavior
Default behavior:
- push automatically after each commit

### Branch behavior
This needs to be safe for both engineers and non-engineers.

Default proposed behavior:
- if repo is clean, create a dedicated branch automatically
- if repo is dirty, ask user what to do
- if user is clearly non-technical, describe branch creation in simple English

Provisional branch naming:
- `samospec/<topic>`

User options should include:
- use safe separate branch (default)
- use current branch
- local-only / do not push
- dry run / no commit

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
- max reviewer count
- max iteration count
- budget guardrails
- failure handling when one reviewer flakes out

### Gemini budget policy
Gemini is optional and off by default until budget handling is strong enough.
Needed controls:
- explicit opt-in
- per-run hard limit
- max total spend/tokens per refinement session
- fail closed if budget tracking is unavailable

## Stopping conditions
Stop refinement when any of:
- max iterations reached
- lead expert marks ready
- two consecutive rounds produce no substantial improvements
- user interrupts / takes over

## Commands (provisional)
- `samospec new`
- `samospec refine`
- `samospec review`
- `samospec tldr`
- `samospec status`

Possible future:
- `samospec export`
- `samospec doctor`
- `samospec compare`

## Tests / CI / red-green TDD
Need tests for:

### CLI behavior
- no repo vs existing repo
- empty repo vs populated repo
- missing model tool detection
- invalid user input paths
- `.samo/spec/` layout creation

### Workflow behavior
- lead expert confirmation flow
- max 5 questions
- correct support for “decide for me” / “not sure” / custom answer
- spec file created at correct path
- changelog/version initialized
- review loop respects N and M
- convergence / stop rules work
- git commits happen at expected steps
- push behavior works as configured
- branch selection behavior works safely

### Integration tests
- mocked Claude/Codex/OpenCode/Gemini adapters
- deterministic review/refinement loop
- failure handling when one reviewer fails
- Gemini disabled-by-default policy
- budget cap enforcement hooks
- all review artifacts written into git

### Red/green TDD focus
Use red/green for:
- workflow-state transitions
- loop stopping logic
- git commit behavior
- branch safety behavior
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
- detect/init repo
- create `.samo/spec/`
- lead expert selection
- up-to-5 interview questions
- generate v0.1 spec
- commit + push

### Sprint 2 — review loop
- reviewer orchestration
- version bumping
- changelog updates
- iterative commits
- TL;DR output
- review artifact persistence

### Sprint 3 — policy + safety
- Gemini gating
- budget controls
- convergence logic
- branch behavior polish
- retry/failure handling

### Sprint 4 — polish
- better prompts
- better non-engineer UX
- stronger tests
- docs/examples

Parallelization:
- model adapters can be built in parallel with git/layout logic
- review loop can be built in parallel with TL;DR rendering

## Open questions
- exact UX for branch selection in non-engineer mode
- whether `TLDR.md` should always be committed or generated on demand
- whether review artifacts should ever be pruned automatically
- whether topic names determine `.samo/spec/` subdirectories later
- whether OpenCode stays optional or becomes a first-class default reviewer

## Changelog

### v0.2
- dogfooded product spec rewrite
- switched storage model to `.samo/spec/`
- broadened scope beyond software-only use
- made automatic commit/push behavior explicit
- set default review count to 2
- required all review artifacts to be stored in git
- added branch-safety and budget-policy sections

### v0.1
- initial concept spec created
