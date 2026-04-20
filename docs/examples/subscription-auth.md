# OAuth (subscription auth) example

Copyright 2026 Nikolay Samokhvalov.

Claude Max and Claude Pro users authenticate via subscription (browser OAuth)
rather than an API key. samospec inherits that session for non-interactive
work calls — no API key env var required.

## Happy path: OAuth only

```bash
# Authenticate once, interactively:
claude /login

# Confirm it works (samospec runs a live probe):
samospec doctor
# OK    auth  claude: authenticated via OAuth
# OK    auth  codex: authenticated
```

Then run samospec normally:

```bash
samospec new my-feature --idea "..."
samospec iterate
```

## What changes under OAuth

When Claude Code is authenticated via subscription (no `ANTHROPIC_API_KEY`
set), the adapter returns `subscription_auth: true`. samospec detects this
automatically and applies the subscription-auth escape (SPEC §11):

- Token budgets are replaced by wall-clock and iteration caps.
- Wall-clock cap: 240 minutes per session.
- Iteration cap: enforced per round via `policy.max_rounds`.
- Cost summaries show `unknown — OAuth (no per-token cost visibility)` instead
  of a USD value.

The run is **not blocked** — this is the intended happy path for subscription
users.

## Doctor output under OAuth

```
OK    auth  claude: authenticated via OAuth
```

If the probe succeeds, this is `OK`. If the probe fails for any reason,
doctor will `WARN` with specific guidance.

## Stale ANTHROPIC_API_KEY preempting OAuth

If you previously set `ANTHROPIC_API_KEY` and it's now stale or invalid,
the Claude CLI will prefer it over the OAuth session. Doctor shows:

```
WARN  auth  claude: claude -p probe failed with 'Invalid API key'. If you're
            using OAuth (claude /login), a stale ANTHROPIC_API_KEY env var
            may be preempting it — try unsetting it.
```

Fix: `unset ANTHROPIC_API_KEY` and re-run `samospec doctor`.

## Mixed auth (subscription lead, API reviewer)

If the lead (Claude) is on OAuth and Reviewer A (Codex) has `OPENAI_API_KEY`
set, both will work. The combined cost summary shows the Codex cost and
`unknown — OAuth` for Claude. The wall-clock + iteration caps apply to the
Claude side.

## API key as an alternative

If you prefer API-key auth, export the key and samospec will use it:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # get at console.anthropic.com
export OPENAI_API_KEY="sk-..."          # get at platform.openai.com
samospec doctor
# OK    auth  claude: authenticated
# OK    auth  codex: authenticated
```

With API keys, token budgets, dollar estimates, and the consent gate all
apply normally.
