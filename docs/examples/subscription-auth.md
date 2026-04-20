# Subscription auth (Claude Max / Pro)

Copyright 2026 Nikolay Samokhvalov.

Claude Max and Claude Pro users authenticate via subscription rather than an
API key. This changes how `samospec` reports costs and enforces limits.

## What changes

When Claude Code is authenticated via subscription, the adapter returns
`subscription_auth: true` and cannot report token counts. `samospec` detects
this automatically and applies the subscription-auth escape (SPEC §11):

- Token budgets are replaced by wall-clock and iteration caps.
- Wall-clock cap: 240 minutes per session (same as API users).
- Iteration cap: enforced per round via the configured `policy.max_rounds`.
- Cost summaries show `(subscription; cost not tracked)` instead of a USD value.

## Doctor output

`samospec doctor` surfaces subscription auth explicitly:

```
WARN  auth  claude: authenticated via subscription (user@example.com)
            — token cost not visible; wall-clock + iteration caps enforced
```

This is a WARN, not a FAIL. The session continues normally.

## Session experience

The workflow is identical to API-key auth. The only visible differences:

- No cost estimate at preflight (shows `N/A — subscription auth`).
- Round cost summaries show `subscription; cost not tracked`.
- `state.json` records `calibration.cost_per_run_usd` as `0` for
  subscription sessions (so calibration arrays stay in sync).

## Mixed auth (subscription lead, API reviewer)

If the lead is on subscription and Reviewer A (Codex) is on an API key, the
lead runs under subscription-auth escape while Reviewer A reports token usage
normally. The combined cost summary shows the Codex cost and `N/A` for Claude.

## Calibration note

Subscription-auth sessions still record calibration samples (rounds to
converge, rough token counts estimated from context sizes). After 3+ sessions
the preflight estimate improves for iteration and timing — even without cost
visibility.
