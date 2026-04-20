# SamoSpec

SamoSpec (`samospec`) is a git-native CLI that turns a rough idea into a
strong, versioned specification document through a structured dialogue between
the user, one lead AI expert, and a small panel of AI review experts — with
every material step automatically captured in git. It is part of the
[samo](https://github.com/NikolayS/samospec) project ecosystem and ships as
an npm package under the `samospec` name. The tool runs locally, orchestrates
Claude Code, Codex, and (post-v1) additional vendors behind one opinionated
workflow, and requires no external state beyond a git repository.

## Install

Requires [Bun](https://bun.sh) >= 1.2.0.

```bash
bunx samospec
```

or install globally:

```bash
bun install -g samospec
samospec --version
```

Note: `npx` is NOT supported in v0.1.0. Use `bunx` or a global Bun install.

## Quickstart

These three commands take an idea to a reviewed, version-controlled spec.

```bash
samospec init
samospec new my-feature --idea "Describe the feature here"
samospec iterate
```

**Prerequisites:**

- A real [Claude Code](https://claude.ai/download) installation with
  `ANTHROPIC_API_KEY` set (get a key at
  [console.anthropic.com](https://console.anthropic.com)).
- A real [Codex](https://platform.openai.com/docs/guides/codex) installation
  with `OPENAI_API_KEY` set (get a key at
  [platform.openai.com](https://platform.openai.com)).
- Both env vars must be present for non-interactive work calls. Subscription
  auth (Claude Max/Pro, ChatGPT login) is **detected** by `samospec doctor`
  but **cannot drive work calls** in v1 — `claude --print` rejects subscription
  tokens. See [docs/troubleshooting.md](docs/troubleshooting.md).

`samospec doctor` checks everything before you start.

- `samospec init` — initialise `.samo/` in the current git repo (idempotent).
- `samospec new <slug> --idea "..."` — start a new spec; leads you through
  persona selection, a five-question strategic interview, and writes v0.1.
- `samospec iterate` — run review rounds (lead + two reviewers in parallel)
  until converged, at the iteration cap, or on your request.
- `samospec publish <slug>` — promote the final spec to `blueprints/`, commit,
  push (if consented), and open a PR via `gh` or `glab`.
- `samospec doctor` — check CLI availability, auth, config sanity, calibration,
  push consent, and global-config contamination before running anything.

## Full specification

See [`.samo/blueprints/SPEC.md`](.samo/blueprints/SPEC.md) for the complete
product spec (architecture, state machines, adapter contract, publish lint,
dogfood scorecard, threat model, and implementation plan).

## Not in v0.1.0

The following are explicitly deferred and are NOT in this release:

- Homebrew, apt, or standalone binary distribution — use `bunx` or `bun install -g`.
- Gemini and OpenCode adapters — Claude Code + Codex only in v0.1.0.
- Non-software persona packs (marketing, ops playbooks, research specs).
- `samospec compare`, `samospec diff`, `samospec export`.
- `samospec experts set` — edit `.samo/config.json` manually until v0.2.

## License

UNLICENSED. Copyright 2026 Nikolay Samokhvalov.
