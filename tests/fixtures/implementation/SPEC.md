# SPEC v1.0

## Goal & why it's needed

Ship a GitHub-native backlog creator for accepted samospec specifications.

## Team

- 1x Veteran "TypeScript CLI engineer" expert — owns parser and command flow.
- 1x Veteran "GitHub automation engineer" expert — owns issue posting safety.
- 1x Veteran "QA/TDD engineer" expert — owns duplicate and dry-run tests.

## Implementation plan

### Sprint 1 — backlog extraction (1 week)

- [TypeScript CLI engineer] Parse `Team` and first sprint markdown into
  deterministic work items with stable task slugs.
- [GitHub automation engineer] Create GitHub issues through an injectable
  adapter and skip any issue whose samospec task marker already exists.
- [QA/TDD engineer] Add red/green TDD coverage for dry-run and retry
  duplicate resistance.

**Exit:** Dry-run prints the planned first sprint backlog and posting creates no
duplicates on retry.

### Sprint 2 — manager dashboard (1 week)

- [TypeScript CLI engineer] Render a progress dashboard from linked issues.

## Embedded Changelog

- v1.0 — accepted.
