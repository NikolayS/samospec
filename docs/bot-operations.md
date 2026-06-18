# Bot / agent operations runbook

Copyright 2026 Nikolay Samokhvalov.

This is the self-contained guide for driving `samospec` from an **autonomous
agent, bot, or CI job** — no human at the keyboard. Everything below is
verified against the CLI in this repo. The authoritative usage block is always
`bunx samospec` with no arguments; this doc explains the non-interactive paths
that a human-oriented session never hits.

> **No secrets in this doc.** Only environment-variable _names_ appear. Never
> commit a token, key, or password to the repo or to a committed transcript.

---

## 1. What samospec is

`samospec` is a git-native CLI that turns a rough idea into a reviewed,
versioned `SPEC.md`. A **lead** model drafts; two **reviewers** (one Codex,
one a second Claude session) critique with different personas; the lead
revises; the loop repeats until an explicit stopping condition fires. Every
round is a git commit on a `samospec/<slug>` branch, so the spec carries real
`v0.1 → v0.2 → … → v1.0` history you can diff and blame. There is **no
server and no daemon** — the bot invokes a CLI, which shells out to the
vendor CLIs (`claude`, `codex`) as subprocesses.

---

## 2. Install & runtime

- **Runtime:** [Bun](https://bun.sh) ≥ 1.2.0. `npx` does **not** work — the CLI
  ships as TypeScript and uses `Bun.spawn`. Always use `bunx`/`bun`.
- **No install step:** `bunx samospec <command>` fetches and caches the CLI on
  first use. To run from a clone instead: `bun run src/main.ts <command>` (the
  `package.json` `bin` points at `./src/main.ts`).
- **Vendor CLIs on PATH:** `claude` (Claude Code, **≥ v2.1.0** — samospec
  passes `--effort` on every call and older CLIs reject it) and `codex` (OpenAI
  Codex CLI). `samospec doctor` reports any that are missing or too old.
- **A git repo:** every command runs inside a git working tree. `samospec init`
  scaffolds `.samo/` in the current repo.

```bash
bunx samospec --version   # prints the version, exits 0
bunx samospec doctor      # environment preflight (see §3)
```

---

## 3. Credential / setup checklist

samospec never takes credentials as flags or arguments — it inherits them from
the vendor CLIs' own auth state and from the environment. OAuth is the happy
path; API keys are an alternative.

| Seat              | Vendor CLI | OAuth setup (preferred)                  | API-key env var (alternative) |
| ----------------- | ---------- | ---------------------------------------- | ----------------------------- |
| Lead + Reviewer B | `claude`   | `claude /login` (run once interactively) | `ANTHROPIC_API_KEY`           |
| Reviewer A        | `codex`    | `codex auth` (ChatGPT-account login)     | `OPENAI_API_KEY`              |

Notes for a bot:

- **Claude via OAuth subprocess (the Samo policy).** The recommended setup is
  the `claude /login` OAuth session — samospec then drives Claude through
  `claude --print` (`-p`) subprocess calls that inherit that session. No
  `ANTHROPIC_API_KEY` is required in this mode, and samospec reports it as
  `authenticated via OAuth`. This matches the Samo convention that Claude calls
  go through the user's `claude` OAuth subprocess rather than a raw API key.
- `ANTHROPIC_API_KEY` is accepted as an alternative, but a **stale/invalid**
  one _preempts_ the OAuth session (the Claude CLI prefers the env var) and the
  whole run fails with `Invalid API key`. If you intend OAuth, ensure
  `ANTHROPIC_API_KEY` is **unset** in the bot's environment.
- **Codex is a full reviewer LLM here.** Its `OPENAI_API_KEY` (when used) drives
  chat/reasoning calls for Reviewer A — this is _not_ an images-only usage.
  ChatGPT-account OAuth via `codex auth` works and is preferred; the adapter
  auto-falls-back through the model chain if your account default differs.
- **Git remote auth** (for `iterate --push` / `publish`): the bot's git client
  must be able to push to the remote (HTTPS token or SSH key), and `gh` (or
  `glab`) must be authenticated for `publish` to open a PR. samospec does not
  manage these — they live in the standard git / `gh` config.
- **Minimal-env spawn:** subprocesses see only `HOME`, `PATH`, `TMPDIR`,
  `USER`, `LOGNAME`, plus the declared auth vars (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`). Nothing else from the bot's environment bleeds through.

Run the preflight and gate on it:

```bash
bunx samospec doctor
# Exit 0 = OK/WARN (safe to proceed). Exit 1 = a critical check FAILED.
```

`doctor` runs these checks in order: **availability, effort-support, auth, git,
lock, config, global-config, entropy, push-consent, calibration,
pr-capability**. WARN-level findings (e.g. stale API key, old `claude`, a global
`~/.claude/CLAUDE.md` that could steer the model) do not block; only FAIL does.

---

## 4. Command surface (copy-paste, non-interactive)

The full create → refine → publish workflow, every command driven without a
TTY. Replace `<slug>` with a filesystem-safe identifier (it is **not** semantic
— the `--idea` text is the authoritative source of meaning).

### 4.1 Scaffold

```bash
bunx samospec init --yes        # idempotent; creates .samo/config.json + .gitignore
```

### 4.2 Create the first draft (`new`)

`new` runs a persona proposal + a ≤5-question interview, then drafts v0.1.
**In a non-TTY context you MUST pass one of** `--yes`, `--accept-persona`, or
`--answers-file <path>`, or `new` exits 1 with guidance (it refuses to
readline-deadlock).

```bash
# Fully hands-off: accept the proposed persona, default every answer to
# "decide for me". --idea-file avoids fragile shell quoting for long ideas.
bunx samospec new linkrot \
  --idea-file ./idea.md \
  --yes \
  --effort high

# Steer the 5 interview answers from JSON instead of defaulting them:
#   answers.json = { "answers": ["a", "b", "c", "d", "e"] }
bunx samospec new linkrot --idea "Detect dead links in Markdown" \
  --accept-persona --answers-file ./answers.json
```

Other `new` flags: `--skip <comma,list>` (omit baseline sections — valid names
come from the usage block), `--force` (archive an existing `<slug>` dir first),
`--verbose` (stderr diagnostics), `--max-session-wall-clock-ms <ms>`
(**deprecated no-op**, accepted but ignored).

`--idea` and `--idea-file` are **mutually exclusive**.

#### JSONL interview protocol (for UI wrappers / tight control)

For a bot that wants to _answer_ the interview programmatically rather than
defaulting it, drive the interview over a line-delimited JSON event stream:

```bash
bunx samospec new linkrot --idea "…" --interview-protocol jsonl
```

- **stdout** emits exactly one JSON object per line, each carrying `"v":1`:
  `{"type":"persona-proposal",…}`, `{"type":"question","id","text","options",…}`,
  and a terminal `{"type":"complete","v":1}`.
- **stdin** consumes `{"type":"persona-answer","kind":"accept"|"edit"|"replace",…}`
  then one `{"type":"answer","id","choice","custom"?}` per question.
- Human-facing notices go to **stderr**, so stdout stays protocol-clean.
- This **bypasses** the non-TTY refusal (the protocol _is_ the non-TTY driver).
  If both `--yes` and `--interview-protocol jsonl` are passed, JSONL wins.
- Reference driver: `tests/cli/new-interview-protocol-jsonl.test.ts`.

### 4.3 Refine (`iterate`)

Runs review rounds (lead + both reviewers in parallel) until a stopping
condition fires. Non-TTY runs must resolve two prompts up front:

```bash
# Local-only refinement, capped at 5 rounds, no prompts:
bunx samospec iterate linkrot --rounds 5 --no-push --on-dirty incorporate

# Push round commits, granting first-push consent non-interactively:
bunx samospec iterate linkrot \
  --push-consent yes \
  --on-dirty incorporate \
  --remote origin

# "Accept everything" shorthand (implies --push-consent yes):
bunx samospec iterate linkrot --yes --on-dirty incorporate
```

- `--rounds <N>` is a safety **cap**, not a target — the loop normally stops
  earlier on a convergence condition (see §5).
- `--on-dirty <incorporate|overwrite|abort>` answers the uncommitted-edits
  prompt. **Required** in a non-TTY run when the slug dir has dirty edits.
- `--push-consent <yes|no>` answers the first-push consent prompt. **Required**
  (or `--no-push`, or `--yes`) in a non-TTY run on the first push to a remote
  with no persisted consent — otherwise `iterate` exits 1 _before_ round 1 with
  the exact flags to add.
- `--quiet` suppresses the per-round progress/heartbeat on stderr (final
  summary still prints to stdout). `--verbose` is a no-op alias.
- Unknown flags are **rejected** (exit 1) so typos like `--rouns` are caught.

### 4.4 Inspect / resume

```bash
bunx samospec status linkrot    # phase, version, round index, last-round summary, next action
bunx samospec resume linkrot    # idempotent resume from a crash/kill at any round boundary
```

`resume` re-enters from the last committed round; it does **not** retry a
`lead-terminal` failure automatically (edit `SPEC.md` first — see
[troubleshooting.md](troubleshooting.md)).

### 4.5 Publish

```bash
bunx samospec publish linkrot                 # promote → commit → push → open PR via gh/glab
bunx samospec publish linkrot --no-lint       # skip the publish-time lint pass
bunx samospec publish linkrot --remote upstream
```

Promotes the working draft to `<blueprints_dir>/<slug>/SPEC.md`, commits, pushes
the `samospec/<slug>` branch, and opens a PR targeting `main`. Requires git
push auth and an authenticated `gh`/`glab`.

### 4.6 Brief (derived HTML summary)

```bash
bunx samospec brief linkrot                       # heuristic HTML → <blueprints_dir>/<slug>/BRIEF.html
bunx samospec brief linkrot --out docs/linkrot/index.html
bunx samospec brief linkrot --ai                  # rich AI-generated brief (lead adapter + verifier)
bunx samospec brief linkrot --ai --no-cache       # force fresh AI generation
bunx samospec brief linkrot --ai --no-verify      # skip the cross-vendor verifier pass
```

`--no-nojekyll` skips creating the repo-root `.nojekyll` marker (created
idempotently by default for GitHub Pages). The brief is a **derivative summary**
of the published spec, not the spec itself.

---

## 5. Stopping conditions, exit codes & gotchas

### Exit codes (the bot should branch on these)

| Exit | Meaning                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success. For `iterate`: stopped on `ready`, `semantic-convergence`, or `max-rounds`.                                   |
| `1`  | Usage / preflight error (missing slug, unknown flag, non-TTY without the required automation flag, missing `SPEC.md`). |
| `2`  | Argument-value error (e.g. a bad `--effort` value) or a mid-run user/consent abort path.                               |
| `3`  | Interrupted by SIGINT (`sigint`).                                                                                      |
| `4`  | Terminal run-time stop: `lead-terminal`, `reviewers-exhausted`, `budget`, `wall-clock`, or `lead-ignoring-critiques`.  |

For `iterate`, the stop reason is in the run summary and persisted to
`state.json`. Reason → exit-code mapping is authoritative in
`src/loop/stopping.ts` (`stopReasonExitCode`).

### Convergence is defined, not vibes

`iterate` ends on its own when any of these fire: **lead-ready**,
**semantic-convergence**, **repeat-findings halt** (trigram-Jaccard), **budget
cap**, **max-rounds cap**, **reviewers-exhausted**, or **SIGINT**. A bot does
_not_ need to poll-and-kill; let the loop terminate.

### Caps are caps, not targets

`--rounds N` and the per-seat budget caps are **safety ceilings**. Designing a
bot loop that always burns all N rounds is wrong — the natural termination
signal (convergence) should end most runs early. Use a cap as a backstop only.

### No wall-clock kill

The session wall-clock kill was **removed**. `--max-session-wall-clock-ms` is a
deprecated no-op (accepted, ignored). LLM calls run as long as they need; the
only stop signals are the **inactivity heartbeat** and **SIGTERM/SIGINT**. Do
not wrap samospec in an external "kill after N minutes" timeout expecting
graceful behaviour — send SIGTERM and let it checkpoint.

### Non-TTY refusals are the most common bot failure

- `new` in a non-TTY without `--yes` / `--accept-persona` / `--answers-file`
  → exit 1.
- `iterate` with a dirty slug dir and no `--on-dirty` → exit 1.
- `iterate` first push with no `--push-consent` / `--no-push` / `--yes`
  → exit 1 _before_ round 1.

All three print the exact flag to add. The effort prompt and all interactive
readlines are auto-skipped under these automation flags / piped stdin.

### Other failure recovery

See [troubleshooting.md](troubleshooting.md) for: stale `ANTHROPIC_API_KEY`,
Codex `model_unavailable` under ChatGPT auth, `lead-terminal` recovery, stale
`.samo/.lock` removal, offline resume, and global-config contamination.

---

## 6. What runs where & where output lands

- **Where it runs:** entirely on the machine invoking the CLI. samospec spawns
  `claude` and `codex` as **local subprocesses** (minimal env). Those CLIs make
  the network calls to their vendors. There is no samospec server.
- **Defaults today** (overridable in `.samo/config.json` → `paths`):
  - Working drafts: `.samo/spec/<slug>/`
  - Published snapshots & briefs: `blueprints/<slug>/`
- **Working draft contents** (`<spec_dir>/<slug>/`), read/written every round:
  - `SPEC.md` (canonical during iteration), `TLDR.md`, `state.json` (phase +
    round bookkeeping the bot can parse), `interview.json`, `context.json`,
    `decisions.md`, `changelog.md`, `architecture.json` (Zod-validated machine
    diagram), `reviews/rNN/` and `rounds/rNN/round.json` (per-round artifacts),
    `transcripts/` (**gitignored**, redacted even when opted in).
- **Published output** (`<blueprints_dir>/<slug>/`): `SPEC.md` (immutable
  promoted copy) and, after `brief`, `BRIEF.html`.
- **Runtime / config** (always under `.samo/`, never relocated): `config.json`
  (committed), `.lock`, `cache/`, `transcripts/` (gitignored).
- **Branch:** every spec's commits live on `samospec/<slug>`; `publish` opens a
  PR from that branch into `main`. samospec never commits to a protected branch.

### Programmatic state

`state.json` and `rounds/rNN/round.json` are the bot's structured read-back:
phase, current version, round index, stop reason, and (for Codex) whether the
account-default tier resolved (`"account_default": true`). Parse these instead
of scraping stdout.

```bash
# Example: did Codex fall back to the account-default model this round?
cat .samo/spec/<slug>/rounds/r<N>/round.json | grep account_default
```
