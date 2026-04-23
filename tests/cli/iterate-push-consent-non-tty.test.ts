// Copyright 2026 Nikolay Samokhvalov.

// Issue #136 — `samospec iterate --push-consent <yes|no>` (and `--yes`
// which implies `--push-consent yes`) wires the first-push consent
// prompt into the non-TTY safety net introduced in #114.
//
// Without the flag and with stdin not a TTY, iterate must fail-fast
// BEFORE round 1 starts with an actionable error — never readline-
// deadlock at the end of round 1 with ERR_USE_AFTER_CLOSE.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

const CLI_PATH = path.resolve(import.meta.dir, "..", "..", "src", "main.ts");

let tmp: string;
let bare: string;
let fakeHome: string;
let fakeBin: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-iterate-pushconsent-"));
  bare = mkdtempSync(path.join(tmpdir(), "samospec-iterate-pushconsent-bare-"));
  fakeHome = mkdtempSync(
    path.join(tmpdir(), "samospec-iterate-pushconsent-home-"),
  );
  fakeBin = mkdtempSync(
    path.join(tmpdir(), "samospec-iterate-pushconsent-bin-"),
  );

  // Adapter stubs that sleep on any non-version call. The "no refusal"
  // assertions below rely on spawnSync timing out after a few seconds —
  // by then, argv parsing and any preflight refusal have already run,
  // so stderr is stable. `exit 1` stubs would otherwise push iterate
  // into the `reviewer exhausted` path which has its own readline
  // prompt unrelated to push-consent (out of scope for #136).
  const stubBody =
    '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then ' +
    "echo '0.0.0'; exit 0; fi\nsleep 60\n";
  for (const name of ["claude", "codex"]) {
    const p = path.join(fakeBin, name);
    writeFileSync(p, stubBody);
    chmodSync(p, 0o755);
  }

  // Bare remote so push attempts have somewhere to land (not exercised
  // in the fast-refusal tests, but needed so the preflight check sees
  // a configured remote URL).
  spawnSync("git", ["init", "--bare", "-q", "--initial-branch", "main"], {
    cwd: bare,
  });

  // Real git repo with a samospec/<slug> branch + origin pointed at bare.
  spawnSync("git", ["init", "-q", "--initial-branch", "main"], { cwd: tmp });
  spawnSync("git", ["config", "user.email", "t@example.invalid"], { cwd: tmp });
  spawnSync("git", ["config", "user.name", "t"], { cwd: tmp });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: tmp });
  writeFileSync(path.join(tmp, "README.md"), "seed\n");
  spawnSync("git", ["add", "README.md"], { cwd: tmp });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd: tmp });
  spawnSync("git", ["remote", "add", "origin", bare], { cwd: tmp });
  spawnSync("git", ["checkout", "-q", "-b", "samospec/demo"], { cwd: tmp });

  // Seed a complete .samo/spec/demo/ — clean (no dirty edits, so the
  // #114 on-dirty path does NOT fire).
  const slugDir = path.join(tmp, ".samo", "spec", "demo");
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(
    path.join(slugDir, "SPEC.md"),
    "# SPEC\n\ncontent v0.1\n",
    "utf8",
  );
  writeFileSync(path.join(slugDir, "TLDR.md"), "# TLDR\n\n- old\n", "utf8");
  writeFileSync(
    path.join(slugDir, "decisions.md"),
    "# decisions\n\n- none.\n",
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "changelog.md"),
    "# changelog\n\n## v0.1 — seed\n\n- initial\n",
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "interview.json"),
    JSON.stringify({
      slug: "demo",
      persona: 'Veteran "demo" expert',
      generated_at: "2026-04-19T12:00:00Z",
      questions: [],
      answers: [],
    }),
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "context.json"),
    JSON.stringify({
      phase: "draft",
      files: [],
      risk_flags: [],
      budget: { phase: "draft", tokens_used: 0, tokens_budget: 0 },
    }),
    "utf8",
  );
  const state: State = {
    slug: "demo",
    phase: "review_loop",
    round_index: 0,
    version: "0.1.0",
    persona: { skill: "demo", accepted: true },
    push_consent: null,
    calibration: null,
    remote_stale: false,
    coupled_fallback: false,
    head_sha: null,
    round_state: "committed",
    exit: null,
    created_at: "2026-04-19T12:00:00Z",
    updated_at: "2026-04-19T12:00:00Z",
  };
  writeState(path.join(slugDir, "state.json"), state);
  spawnSync("git", ["add", "."], { cwd: tmp });
  spawnSync("git", ["commit", "-q", "-m", "spec(demo): draft v0.1"], {
    cwd: tmp,
  });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(fakeBin, { recursive: true, force: true });
});

function runCli(
  args: readonly string[],
  opts: { timeoutMs?: number } = {},
): {
  stdout: string;
  stderr: string;
  status: number;
  elapsedMs: number;
} {
  const bun = Bun.argv[0];
  const env: Record<string, string> = {
    PATH: `${fakeBin}:/usr/bin:/bin:/usr/local/bin`,
    HOME: fakeHome,
    NO_COLOR: "1",
    ANTHROPIC_API_KEY: "sk-fake-test-key",
  };
  const devNull = openSync("/dev/null", "r");
  const started = Date.now();
  const r = spawnSync(bun, ["run", CLI_PATH, ...(args as string[])], {
    cwd: tmp,
    encoding: "utf8",
    env,
    stdio: [devNull, "pipe", "pipe"],
    timeout: opts.timeoutMs ?? 15_000,
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? 1,
    elapsedMs: Date.now() - started,
  };
}

describe("samospec iterate --push-consent (#136)", () => {
  test("non-TTY + no flag + no --no-push -> fast exit 1 BEFORE round 1 with actionable message", () => {
    const res = runCli(["iterate", "demo", "--rounds", "1"]);
    // Must fail fast — well under the stubbed adapter's 60s sleep. The
    // refusal fires before any adapter spawn.
    expect(res.elapsedMs).toBeLessThan(5_000);
    expect(res.status).not.toBe(0);
    // Must not readline-deadlock / crash with ERR_USE_AFTER_CLOSE.
    expect(res.stderr).not.toContain("ERR_USE_AFTER_CLOSE");
    expect(res.stderr).not.toContain("readline");
    // Error names the offending concept + at least one fix.
    expect(res.stderr.toLowerCase()).toContain("push-consent");
    expect(res.stderr.toLowerCase()).toMatch(/--push-consent|--yes|--no-push/);
  });

  test("non-TTY + --no-push -> no refusal (guard must not over-fire)", () => {
    // With --no-push, there's no first-push consent to collect, so
    // the new refusal must NOT fire. The run proceeds into the loop
    // where stubs sleep; spawnSync timeout fires at 3s. By then any
    // refusal text would already be on stderr.
    const res = runCli(["iterate", "demo", "--rounds", "1", "--no-push"], {
      timeoutMs: 3_000,
    });
    expect(res.stderr).not.toContain("ERR_USE_AFTER_CLOSE");
    const mentionsPushConsentRefusal = res.stderr
      .toLowerCase()
      .includes("push consent is required");
    expect(mentionsPushConsentRefusal).toBe(false);
  }, 10_000);

  test("invalid --push-consent value -> exit 1 with validation error (before any work)", () => {
    const res = runCli([
      "iterate",
      "demo",
      "--rounds",
      "1",
      "--push-consent",
      "maybe",
    ]);
    expect(res.elapsedMs).toBeLessThan(5_000);
    expect(res.status).toBe(1);
    // The validator's own error (NOT the allowlist "unknown flag" message)
    // — must name the valid values yes/no.
    expect(res.stderr.toLowerCase()).toContain("--push-consent");
    expect(res.stderr.toLowerCase()).toContain("yes|no");
    expect(res.stderr.toLowerCase()).not.toContain("unknown flag");
  });

  test("--push-consent yes is a known flag (not rejected by allowlist)", () => {
    const res = runCli(
      ["iterate", "demo", "--rounds", "1", "--push-consent", "yes"],
      { timeoutMs: 3_000 },
    );
    // Parser must NOT reject `--push-consent` as unknown — we go
    // past arg parsing and hit the adapter stub, which sleeps until
    // spawnSync's 3s timeout kills the child.
    expect(res.stderr.toLowerCase()).not.toContain(
      "unknown flag '--push-consent'",
    );
    const mentionsPushConsentRefusal = res.stderr
      .toLowerCase()
      .includes("push consent is required");
    expect(mentionsPushConsentRefusal).toBe(false);
  }, 10_000);

  test("--push-consent no is a known flag (not rejected by allowlist)", () => {
    const res = runCli(
      ["iterate", "demo", "--rounds", "1", "--push-consent", "no"],
      { timeoutMs: 3_000 },
    );
    expect(res.stderr.toLowerCase()).not.toContain(
      "unknown flag '--push-consent'",
    );
    const mentionsPushConsentRefusal = res.stderr
      .toLowerCase()
      .includes("push consent is required");
    expect(mentionsPushConsentRefusal).toBe(false);
  }, 10_000);

  test("--yes is a known flag on iterate (not rejected by allowlist)", () => {
    const res = runCli(["iterate", "demo", "--rounds", "1", "--yes"], {
      timeoutMs: 3_000,
    });
    expect(res.stderr.toLowerCase()).not.toContain("unknown flag '--yes'");
    const mentionsPushConsentRefusal = res.stderr
      .toLowerCase()
      .includes("push consent is required");
    expect(mentionsPushConsentRefusal).toBe(false);
  }, 10_000);

  test("non-TTY + persisted consent (yes) -> no refusal (already decided)", () => {
    // Pre-persist consent=true so the resolver would silently
    // short-circuit at the push-consent layer. The CLI preflight
    // SHOULD honor this and not refuse.
    const cfg = {
      schema_version: 1,
      git: { push_consent: { [bare]: true } },
    };
    mkdirSync(path.join(tmp, ".samo"), { recursive: true });
    writeFileSync(
      path.join(tmp, ".samo", "config.json"),
      JSON.stringify(cfg, null, 2) + "\n",
      "utf8",
    );
    const res = runCli(["iterate", "demo", "--rounds", "1"], {
      timeoutMs: 3_000,
    });
    const mentionsPushConsentRefusal = res.stderr
      .toLowerCase()
      .includes("push consent is required");
    expect(mentionsPushConsentRefusal).toBe(false);
  }, 10_000);
});
