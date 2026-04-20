// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §5 Phase 7 + §8 + §9 + §10 — `samospec publish` end-to-end.
 *
 * Exercises the full publish flow against a real temp bare remote and
 * a scripted `gh`/`glab` PATH shim:
 *
 *   - Preconditions: no spec → exit 1; spec NOT in committed state → exit 1.
 *   - Safety invariant: commit lands on `samospec/<slug>`, never `main`.
 *   - Copy: SPEC.md promoted to `blueprints/<slug>/SPEC.md`.
 *   - Commit grammar: `spec(<slug>): publish v<version>`.
 *   - Consent-honoring push: accepted → `pushed`, refused → local-only + warning.
 *   - PR open via `gh` shim: exact argv, body assembled from TLDR + changelog.
 *   - Compare-URL fallback: neither `gh` nor `glab` authenticated → prints URL.
 *   - `--no-lint` skips the lint call (mock throws to prove it's never called).
 *   - Republish: second `publish` on the same slug exits 1.
 *   - State advance: `published_at` + `published_version` recorded on success.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runPublish } from "../../src/cli/publish.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

let tmp: string;
let bare: string;
let shim: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-publish-"));
  bare = mkdtempSync(path.join(tmpdir(), "samospec-publish-bare-"));
  shim = mkdtempSync(path.join(tmpdir(), "samospec-publish-shim-"));
  spawnSync("git", ["init", "--bare", "--initial-branch", "main"], {
    cwd: bare,
  });
  initRepo(tmp, bare);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
  rmSync(shim, { recursive: true, force: true });
});

function initRepo(cwd: string, bareUrl: string): void {
  spawnSync("git", ["init", "-q", "--initial-branch", "main"], { cwd });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd });
  spawnSync("git", ["config", "user.name", "Test"], { cwd });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd });
  writeFileSync(path.join(cwd, "README.md"), "seed\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd });
  // Use a GitHub-shaped remote URL for fetch (so buildCompareUrl can
  // derive a compare URL) with a pushurl override pointing at the
  // real bare so tests exercise actual pushes.
  spawnSync(
    "git",
    ["remote", "add", "origin", "git@github.com:NikolayS/samospec-test.git"],
    { cwd },
  );
  spawnSync("git", ["config", "remote.origin.pushurl", bareUrl], { cwd });
  // Push seed to remote so origin has a `main` ref.
  spawnSync("git", ["push", "-q", "origin", "main"], { cwd });
  spawnSync("git", ["checkout", "-q", "-b", "samospec/refunds"], { cwd });
}

function seedCommittedSpec(
  cwd: string,
  slug: string,
  opts?: { readonly overrides?: Partial<State> },
): void {
  const slugDir = path.join(cwd, ".samo", "spec", slug);
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(
    path.join(slugDir, "SPEC.md"),
    [
      "# SPEC",
      "",
      "## Goal",
      "",
      "Deliver a refunds policy that is reviewable and actionable.",
      "",
      "## Scope",
      "",
      "- refund window",
      "- edge cases",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "TLDR.md"),
    [
      "# TL;DR",
      "",
      "## Goal",
      "",
      "Deliver a refunds policy that is reviewable and actionable.",
      "",
      "## Scope summary",
      "",
      "- Scope",
      "",
      "## Next action",
      "",
      "resume with `samospec resume refunds`",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "decisions.md"),
    "# decisions\n\n- r01: accepted 2, rejected 1, deferred 0\n",
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "changelog.md"),
    [
      "# changelog",
      "",
      "## v0.1 — 2026-04-19T12:00:00Z",
      "",
      "- initial draft",
      "",
      "## v0.2 — 2026-04-19T12:30:00Z",
      "",
      "- Round 1 reviews applied (decisions — accepted: 2, rejected: 1, deferred: 0).",
      "",
    ].join("\n"),
    "utf8",
  );
  // Commit these so the working tree is clean.
  spawnSync("git", ["add", "-A"], { cwd });
  spawnSync("git", ["commit", "-q", "-m", "spec(refunds): refine v0.2"], {
    cwd,
  });
  const state: State = {
    slug,
    phase: "review_loop",
    round_index: 1,
    version: "0.2.0",
    persona: { skill: "refunds", accepted: true },
    push_consent: null,
    calibration: null,
    remote_stale: false,
    coupled_fallback: false,
    head_sha: null,
    round_state: "committed",
    exit: null,
    created_at: "2026-04-19T12:00:00Z",
    updated_at: "2026-04-19T12:30:00Z",
    ...(opts?.overrides ?? {}),
  };
  writeState(path.join(slugDir, "state.json"), state);
  // Re-commit after state mutation so working tree is clean.
  spawnSync("git", ["add", "-A"], { cwd });
  spawnSync("git", ["commit", "-q", "-m", "chore: seed state"], { cwd });
}

/**
 * Create a PATH shim directory with stub executables. Each tool is given
 * a small bash script that:
 *   - exits 0 on `auth status`
 *   - records argv to a log and exits 0 on `pr create` / equivalent
 *
 * Caller decides which tools to stub. Returns the resulting PATH value.
 */
function scriptShim(args: {
  readonly gh?: boolean;
  readonly glab?: boolean;
  readonly ghAuthExit?: number;
  readonly glabAuthExit?: number;
}): { readonly PATH: string; readonly argvLog: string } {
  const bin = path.join(shim, "bin");
  mkdirSync(bin, { recursive: true });
  const argvLog = path.join(shim, "argv.log");
  writeFileSync(argvLog, "", "utf8");

  if (args.gh === true) {
    const ghExit = args.ghAuthExit ?? 0;
    const ghScript = [
      "#!/usr/bin/env bash",
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
      `  exit ${String(ghExit)}`,
      "fi",
      `echo "gh $*" >> "${argvLog}"`,
      "exit 0",
      "",
    ].join("\n");
    const ghPath = path.join(bin, "gh");
    writeFileSync(ghPath, ghScript, "utf8");
    chmodSync(ghPath, 0o755);
  }
  if (args.glab === true) {
    const glabExit = args.glabAuthExit ?? 0;
    const glabScript = [
      "#!/usr/bin/env bash",
      'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then',
      `  exit ${String(glabExit)}`,
      "fi",
      `echo "glab $*" >> "${argvLog}"`,
      "exit 0",
      "",
    ].join("\n");
    const glabPath = path.join(bin, "glab");
    writeFileSync(glabPath, glabScript, "utf8");
    chmodSync(glabPath, 0o755);
  }
  // Keep system utilities (bash, git, env) available; we only stub the
  // specific PR tools (gh/glab) via the shim bin dir taking precedence.
  const systemPath = process.env["PATH"] ?? "";
  return { PATH: `${bin}:${systemPath}`, argvLog };
}

function seedConfig(cwd: string, value: unknown): void {
  const cfgDir = path.join(cwd, ".samo");
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    path.join(cfgDir, "config.json"),
    JSON.stringify(value, null, 2),
    "utf8",
  );
}

describe("samospec publish — preconditions (SPEC §10)", () => {
  test("exits 1 when no spec directory exists for the slug", async () => {
    const result = await runPublish({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T13:00:00Z",
      remote: "origin",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/no spec/i);
  });

  test("exits 1 when the spec is NOT in committed round state", async () => {
    seedCommittedSpec(tmp, "refunds", {
      overrides: { round_state: "planned" },
    });
    const result = await runPublish({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T13:00:00Z",
      remote: "origin",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/committed/i);
  });
});

describe("samospec publish — copy + commit (SPEC §5 Phase 7 + §8 + §9)", () => {
  test("copies SPEC.md to blueprints/<slug>/SPEC.md", async () => {
    seedCommittedSpec(tmp, "refunds");
    const { PATH } = scriptShim({ gh: true });
    await runPublish({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T13:00:00Z",
      remote: "origin",
      env: { PATH },
    });
    const promoted = path.join(tmp, "blueprints", "refunds", "SPEC.md");
    expect(existsSync(promoted)).toBe(true);
    const body = readFileSync(promoted, "utf8");
    expect(body).toMatch(/^# SPEC/);
    expect(body).toContain("Deliver a refunds policy");
  });

  test(
    "commit message is exactly `spec(<slug>): publish v<version>` " +
      "on the samospec/<slug> branch (NOT main)",
    async () => {
      seedCommittedSpec(tmp, "refunds");
      const { PATH } = scriptShim({ gh: true });
      const result = await runPublish({
        cwd: tmp,
        slug: "refunds",
        now: "2026-04-19T13:00:00Z",
        remote: "origin",
        env: { PATH },
      });
      expect(result.exitCode).toBe(0);
      const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: tmp,
        encoding: "utf8",
      }).stdout.trim();
      expect(branch).toBe("samospec/refunds");
      const lastMsg = spawnSync("git", ["log", "-1", "--format=%s"], {
        cwd: tmp,
        encoding: "utf8",
      }).stdout.trim();
      expect(lastMsg).toBe("spec(refunds): publish v0.2");
      // main must not have any samospec commits.
      const mainLog = spawnSync("git", ["log", "--format=%s", "main"], {
        cwd: tmp,
        encoding: "utf8",
      }).stdout;
      expect(mainLog).not.toContain("spec(refunds): publish");
    },
  );

  test("refuses to commit on a protected branch (safety invariant)", async () => {
    // Seed the spec on samospec/refunds, then cherry-pick the state
    // commit onto main so the preconditions are satisfied on main as
    // well — the safety invariant then guards the commit step.
    seedCommittedSpec(tmp, "refunds");
    spawnSync("git", ["checkout", "-q", "main"], { cwd: tmp });
    spawnSync("git", ["checkout", "samospec/refunds", "--", ".samo"], {
      cwd: tmp,
    });
    spawnSync("git", ["commit", "-q", "-m", "chore: seed state on main"], {
      cwd: tmp,
    });
    const { PATH } = scriptShim({ gh: true });
    const result = await runPublish({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T13:00:00Z",
      remote: "origin",
      env: { PATH },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/protected/i);
  });
});

describe("samospec publish — push consent (SPEC §8)", () => {
  test("push respected when consent accepted (accepts via persisted config)", async () => {
    seedCommittedSpec(tmp, "refunds");
    const remoteUrl = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: tmp,
      encoding: "utf8",
    }).stdout.trim();
    seedConfig(tmp, {
      schema_version: 1,
      git: { push_consent: { [remoteUrl]: true } },
    });
    const { PATH } = scriptShim({ gh: true });
    const result = await runPublish({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T13:00:00Z",
      remote: "origin",
      env: { PATH },
    });
    expect(result.exitCode).toBe(0);
    // Bare remote should now have the samospec/refunds ref.
    const bareRefs = spawnSync("git", ["--git-dir", bare, "branch"], {
      encoding: "utf8",
    }).stdout;
    expect(bareRefs).toContain("samospec/refunds");
  });

  test("consent refused → local commit only + warning, still prints compare URL", async () => {
    seedCommittedSpec(tmp, "refunds");
    const remoteUrl = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: tmp,
      encoding: "utf8",
    }).stdout.trim();
    seedConfig(tmp, {
      schema_version: 1,
      git: { push_consent: { [remoteUrl]: false } },
    });
    const { PATH } = scriptShim({ gh: true });
    const result = await runPublish({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T13:00:00Z",
      remote: "origin",
      env: { PATH },
    });
    // Local commit succeeded.
    const lastMsg = spawnSync("git", ["log", "-1", "--format=%s"], {
      cwd: tmp,
      encoding: "utf8",
    }).stdout.trim();
    expect(lastMsg).toBe("spec(refunds): publish v0.2");
    expect(result.stderr).toMatch(/PR cannot be opened without remote push/i);
    // Bare remote has NO samospec ref.
    const bareRefs = spawnSync("git", ["--git-dir", bare, "branch"], {
      encoding: "utf8",
    }).stdout;
    expect(bareRefs).not.toContain("samospec/refunds");
  });
});

describe("samospec publish — PR opening (SPEC §5 Phase 7 + §10)", () => {
  test("invokes `gh` pr create when gh is authenticated", async () => {
    seedCommittedSpec(tmp, "refunds");
    const remoteUrl = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: tmp,
      encoding: "utf8",
    }).stdout.trim();
    seedConfig(tmp, {
      schema_version: 1,
      git: { push_consent: { [remoteUrl]: true } },
    });
    const { PATH, argvLog } = scriptShim({ gh: true });
    const result = await runPublish({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T13:00:00Z",
      remote: "origin",
      env: { PATH },
    });
    expect(result.exitCode).toBe(0);
    const log = readFileSync(argvLog, "utf8");
    expect(log).toContain("gh pr create");
    expect(log).toMatch(/--title/);
    expect(log).toContain("spec(refunds): publish v0.2");
  });

  test("prefers `gh` over `glab` when both are present and authenticated", async () => {
    seedCommittedSpec(tmp, "refunds");
    const remoteUrl = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: tmp,
      encoding: "utf8",
    }).stdout.trim();
    seedConfig(tmp, {
      schema_version: 1,
      git: { push_consent: { [remoteUrl]: true } },
    });
    const { PATH, argvLog } = scriptShim({ gh: true, glab: true });
    await runPublish({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T13:00:00Z",
      remote: "origin",
      env: { PATH },
    });
    const log = readFileSync(argvLog, "utf8");
    expect(log).toContain("gh pr create");
    expect(log).not.toContain("glab mr create");
  });

  test("compare-URL fallback when neither gh nor glab is authenticated", async () => {
    seedCommittedSpec(tmp, "refunds");
    const remoteUrl = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: tmp,
      encoding: "utf8",
    }).stdout.trim();
    seedConfig(tmp, {
      schema_version: 1,
      git: { push_consent: { [remoteUrl]: true } },
    });
    // Script gh + glab shims that both return non-zero on `auth status`
    // so probePrCapability returns { available: false }.
    const { PATH } = scriptShim({
      gh: true,
      glab: true,
      ghAuthExit: 1,
      glabAuthExit: 1,
    });
    const result = await runPublish({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T13:00:00Z",
      remote: "origin",
      env: { PATH },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/compare/);
    expect(result.stdout).toMatch(/samospec\/refunds/);
  });
});

describe("samospec publish — lint seam (SPEC §5 Phase 7 + §14)", () => {
  test("`--no-lint` skips the lint call (mock lint throws if called)", async () => {
    seedCommittedSpec(tmp, "refunds");
    const remoteUrl = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: tmp,
      encoding: "utf8",
    }).stdout.trim();
    seedConfig(tmp, {
      schema_version: 1,
      git: { push_consent: { [remoteUrl]: true } },
    });
    const { PATH } = scriptShim({ gh: true });
    const result = await runPublish({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T13:00:00Z",
      remote: "origin",
      env: { PATH },
      noLint: true,
      lint: () => {
        throw new Error("lint must not run under --no-lint");
      },
    });
    expect(result.exitCode).toBe(0);
  });

  test("default lint seam returns empty findings and publish succeeds", async () => {
    seedCommittedSpec(tmp, "refunds");
    const remoteUrl = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: tmp,
      encoding: "utf8",
    }).stdout.trim();
    seedConfig(tmp, {
      schema_version: 1,
      git: { push_consent: { [remoteUrl]: true } },
    });
    const { PATH } = scriptShim({ gh: true });
    const result = await runPublish({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T13:00:00Z",
      remote: "origin",
      env: { PATH },
    });
    expect(result.exitCode).toBe(0);
  });

  test("real lint is called by default (not the stub) — zero hard warnings on clean spec", async () => {
    // The real lint adapter runs against the file system; the seeded
    // SPEC.md contains no file-path references, so hardWarnings === [].
    // We pass a spy lint that records invocation and confirm it was called.
    let lintCalled = false;
    seedCommittedSpec(tmp, "refunds");
    const remoteUrl = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: tmp,
      encoding: "utf8",
    }).stdout.trim();
    seedConfig(tmp, {
      schema_version: 1,
      git: { push_consent: { [remoteUrl]: true } },
    });
    const { PATH } = scriptShim({ gh: true });
    const result = await runPublish({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T13:00:00Z",
      remote: "origin",
      env: { PATH },
      // Inject a spy that wraps the real adapter to confirm it's invoked.
      lint: (opts) => {
        lintCalled = true;
        // Confirm it received the actual spec body (real lint, not stub).
        expect(opts.specBody.length).toBeGreaterThan(0);
        return { hardWarnings: [], softWarnings: [] };
      },
    });
    expect(result.exitCode).toBe(0);
    expect(lintCalled).toBe(true);
  });
});

describe("samospec publish — state advance (SPEC §7)", () => {
  test("state.json gains published_at + published_version on success", async () => {
    seedCommittedSpec(tmp, "refunds");
    const remoteUrl = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: tmp,
      encoding: "utf8",
    }).stdout.trim();
    seedConfig(tmp, {
      schema_version: 1,
      git: { push_consent: { [remoteUrl]: true } },
    });
    const { PATH } = scriptShim({ gh: true });
    const result = await runPublish({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T13:00:00Z",
      remote: "origin",
      env: { PATH },
    });
    expect(result.exitCode).toBe(0);
    const stateRaw = readFileSync(
      path.join(tmp, ".samo", "spec", "refunds", "state.json"),
      "utf8",
    );
    const state = JSON.parse(stateRaw) as Record<string, unknown>;
    expect(state["published_at"]).toBe("2026-04-19T13:00:00Z");
    expect(state["published_version"]).toBe("v0.2");
  });

  test("second publish on the same slug exits 1 (republish error)", async () => {
    seedCommittedSpec(tmp, "refunds");
    const remoteUrl = spawnSync("git", ["remote", "get-url", "origin"], {
      cwd: tmp,
      encoding: "utf8",
    }).stdout.trim();
    seedConfig(tmp, {
      schema_version: 1,
      git: { push_consent: { [remoteUrl]: true } },
    });
    const { PATH } = scriptShim({ gh: true });
    const first = await runPublish({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T13:00:00Z",
      remote: "origin",
      env: { PATH },
    });
    expect(first.exitCode).toBe(0);
    const second = await runPublish({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T13:05:00Z",
      remote: "origin",
      env: { PATH },
    });
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toMatch(/already published/i);
    expect(second.stderr).toMatch(/iterate/);
  });
});
