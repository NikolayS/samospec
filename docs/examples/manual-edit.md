# Manual editing between rounds

Copyright 2026 Nikolay Samokhvalov.

`samospec` encourages human judgment at every round boundary. You can edit
`SPEC.md` between rounds to capture nuance the lead missed, fix phrasing, or
add context that no reviewer surfaced.

## When to edit manually

- The lead produced a subtly wrong architecture diagram in prose.
- A reviewer raised a finding that you want to resolve directly (without
  waiting for the next lead revision).
- You want to add a constraint that the interview didn't surface.

## How it works

`samospec iterate` detects uncommitted changes to `SPEC.md` at the start of
each round using `git status --porcelain`. If changes are found:

```
samospec: manual edit detected in SPEC.md since last commit.
  Incorporate edit into lead revision? [incorporate/overwrite/abort]
  (default: incorporate)
```

- `incorporate` — the lead sees your edit alongside the reviewer critiques and
  weaves both into the next revision. Your change is never silently discarded.
- `overwrite` — the lead ignores your edit and revises from the committed
  version. Your edit is lost.
- `abort` — exit 0; do not start the round. Commit or discard the edit first.

## Step-by-step example

After round 1, the lead wrote:

```markdown
## Architecture

The system uses a monorepo layout with packages under `src/`.
```

You want it to say:

```markdown
## Architecture

The system uses a flat layout with modules under `src/`.
No workspace packages — a single `package.json` at the root.
```

Edit `.samo/spec/my-spec/SPEC.md` in your editor. Then run:

```bash
samospec iterate my-spec
```

```
samospec: manual edit detected in SPEC.md since last commit.
  Incorporate edit into lead revision? [incorporate/overwrite/abort]
incorporate

samospec: round 2 starting — lead will incorporate your edit + reviewer critiques.
```

The lead receives a directive:

> The user has made a manual edit to the spec. Incorporate it faithfully before
> applying reviewer feedback. Do not revert the user's wording without
> explaining why in the decisions log.

## Scope of edit detection

Edit detection covers `.samo/spec/<slug>/SPEC.md` only. Edits to other files
(decisions.md, context.json) are not detected and are overwritten on the next
commit. Do not hand-edit those files.
