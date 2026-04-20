# Subscription auth (Claude Max / Pro)

Copyright 2026 Nikolay Samokhvalov.

Claude Max and Claude Pro users authenticate via subscription rather than an
API key. samospec **detects** subscription auth and reports it via
`samospec doctor`, but **cannot drive non-interactive work calls** under
subscription auth in v1.

## Why subscription auth doesn't work for work calls

`claude --print` (the non-interactive mode samospec uses for all work calls)
rejects subscription tokens:

```
Invalid API key · Fix external API key
```

The current Claude CLI (v2.1.x) has no flag for subscription-auth + headless
invocation. The same applies to the `codex exec` subcommand under ChatGPT
login. Until vendor CLIs expose a subscription-compatible headless mode,
samospec requires API-key auth for all work calls.

See SPEC §18 for the open question tracking upstream resolution.

## What doctor reports

When Claude Code is authenticated via subscription and `ANTHROPIC_API_KEY` is
not set, `samospec doctor` surfaces:

```
WARN  auth  claude: subscription auth detected; samospec requires
            ANTHROPIC_API_KEY for non-interactive invocation
```

This is a WARN, not a FAIL — the CLI is installed and authenticated, it just
cannot run work calls without an API key.

## How to fix it

Set the API key env var:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # get at console.anthropic.com
export OPENAI_API_KEY="sk-..."          # get at platform.openai.com
```

Then confirm with `samospec doctor`:

```
OK    auth  claude: authenticated
OK    auth  codex: authenticated
```

Now `samospec new` and `samospec iterate` will work normally.

## Mixed auth

If Claude is on subscription without an API key and Codex has `OPENAI_API_KEY`
set, doctor will WARN on the Claude adapter but OK on Codex. `new` will still
fail fast (at the Claude lead call) with `subscription_auth_unsupported`.

## What changes when API key is present

When `ANTHROPIC_API_KEY` is set, samospec uses API-key auth for all work calls
regardless of subscription state. Token budgets, dollar estimates, and the
consent gate all apply normally (API-key path is the default, fully supported
path). Subscription quota is not consumed via samospec in this mode.
