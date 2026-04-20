# Troubleshooting

Copyright 2026 Nikolay Samokhvalov.

Common failures and how to recover.

## Adapter not found

```
FAIL  availability  claude: not installed
```

Install Claude Code from https://claude.ai/download and ensure the `claude`
binary is on your `PATH`. Then run `samospec doctor` again.

For Codex:

```
FAIL  availability  codex: not installed
```

Install the OpenAI CLI: https://platform.openai.com/docs/guides/codex.

## Auth refused

```
FAIL  auth  claude: not authenticated
```

Run `claude auth login` or `claude login` per the Claude Code documentation.
For Codex, run `codex auth login` with a valid `OPENAI_API_KEY` in your
environment.

## Stale ANTHROPIC_API_KEY preempting OAuth

```
WARN  auth  claude: claude -p probe failed with 'Invalid API key'. If you're
            using OAuth (claude /login), a stale ANTHROPIC_API_KEY env var may
            be preempting it — try unsetting it.
```

A stale or invalid `ANTHROPIC_API_KEY` in your environment is overriding the
OAuth session set up by `claude /login`. The Claude CLI prefers the env var
over the OAuth keychain session.

**Fix:** unset the env var and let OAuth take over:

```bash
unset ANTHROPIC_API_KEY
samospec doctor
```

Or, if you do want API-key auth, provide a valid key:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # get at console.anthropic.com
samospec doctor
```

## Reviewer A keeps failing with model_unavailable (ChatGPT auth)

```
samospec: terminal — model_unavailable: all fallbacks exhausted:
  gpt-5.1-codex-max → gpt-5.1-codex → account-default (no --model flag);
  account is not authorized or no model is available
```

Codex under ChatGPT-account auth (browser login via `codex auth`) does not
support the pinned models `gpt-5.1-codex-max` and `gpt-5.1-codex`. The
adapter tries a three-tier fallback chain:

- `gpt-5.1-codex-max` (default pin)
- `gpt-5.1-codex` (explicit fallback)
- account-default: no `--model` flag, letting codex pick the account's
  supported model

If the account-default tier **succeeds**, the round continues and `round.json`
records `"account_default": true`. Run `samospec status` to see the degraded
resolution notice.

If the account-default tier also fails, the entire adapter is terminal. This
means your ChatGPT subscription does not include Codex API access at all.

**Options:**

- Upgrade your ChatGPT plan to one that includes Codex API access.
- Switch to API-key auth: set `OPENAI_API_KEY` in your environment.
- Disable Reviewer A and run with Reviewer B only (edit `.samo/config.json`).

**Verify** which tier resolved via `round.json`:

```bash
cat .samo/spec/<slug>/rounds/r<N>/round.json | grep account_default
```

## lead_terminal — other causes

```
samospec: lead_terminal — lead refused or schema-validation failed.
Exit code: 4.
```

This means the lead adapter returned an unrecoverable error (refusal, or two
consecutive schema-validation failures on the same call). The session is paused.

Recovery options:

- Write v0.1 manually in `.samo/spec/<slug>/SPEC.md`, then run
  `samospec iterate <slug>`.
- Check `samospec status <slug>` for the last committed version.
- Check adapter logs for rate-limit or content-policy messages.

Note: `samospec resume <slug>` re-enters from the last committed round — it
will not retry the lead_terminal call automatically. You must edit SPEC.md
first.

## Consent refused — push skipped

```
samospec: push skipped — consent refused.
PR cannot be opened without remote push.
```

You refused push consent when prompted. The session continues local-only.
To push later:

```bash
git push origin samospec/<slug>
gh pr create --base main --head samospec/<slug>
```

Or re-run `samospec publish <slug>` after clearing the stored refusal:

```bash
# Edit .samo/config.json, remove the git.push_consent entry for your remote.
samospec publish <slug>
```

## Stale lockfile

```
FAIL  lock  stale .samo/.lock (pid 99999, dead) — run `rm .samo/.lock` to clear.
```

A previous session crashed without releasing the lock. Remove it:

```bash
rm .samo/.lock
```

Then re-run your command.

## Offline resume

If your network connection drops mid-session:

```
samospec: remote unreachable — continuing offline (remote_stale: true).
```

The session continues locally. On reconnection, run `samospec resume <slug>`
to fetch remote changes and reconcile. If the remote HEAD moved (non-fast-
forward), the resume halts with:

```
samospec: remote HEAD moved; cannot fast-forward. Resolve manually.
```

Merge or rebase the remote changes onto your local `samospec/<slug>` branch,
then re-run resume.

## Global config contamination

```
WARN  global-config  ~/.claude/CLAUDE.md detected — may steer AI behavior
```

A global `CLAUDE.md` or Codex preamble in your home directory can override
system-prompt hardening and steer adapter behavior in ways `samospec` cannot
see. Consider removing or scoping the file to specific projects. See
`.samo/blueprints/SPEC.md §14` for details.

## TODO: weekly live CI

A weekly workflow against real CLIs with a fixed prompt corpus is not yet
implemented. This is a post-v0.1 operational task. See
[docs/security.md](security.md) for the current CI posture.
