// Copyright 2026 Nikolay Samokhvalov.

// Issue #114 — `samospec iterate --on-dirty <incorporate|overwrite|abort>`
// skips the uncommitted-edits readline so `iterate` works in non-TTY.
// Without the flag and with dirty `.samo/spec/<slug>/`, non-TTY stdin
// must exit 1 fast with a clear message — never readline-deadlock.

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
let fakeHome: string;
let fakeBin: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-iterate-ondirty-"));
  fakeHome = mkdtempSync(path.join(tmpdir(), "samospec-iterate-ondirty-home-"));
  fakeBin = mkdtempSync(path.join(tmpdir(), "samospec-iterate-ondirty-bin-"));

  const stubBody =
    '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then ' +
    "echo '0.0.0'; exit 0; fi\nsleep 60\n";
  for (const name of ["claude", "codex"]) {
    const p = path.join(fakeBin, name);
    writeFileSync(p, stubBody);
    chmodSync(p, 0o755);
  }

  // Init a real git repo with a samospec/<slug> branch.
  spawnSync("git", ["init", "-q", "--initial-branch", "main"], { cwd: tmp });
  spawnSync("git", ["config", "user.email", "t@example.invalid"], { cwd: tmp });
  spawnSync("git", ["config", "user.name", "t"], { cwd: tmp });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: tmp });
  writeFileSync(path.join(tmp, "README.md"), "seed\n");
  spawnSync("git", ["add", "README.md"], { cwd: tmp });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd: tmp });
  spawnSync("git", ["checkout", "-q", "-b", "samospec/demo"], { cwd: tmp });

  // Seed a complete .samo/spec/demo/ from the iterate test helper shape.
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

  // Now dirty SPEC.md in the working tree so detectManualEdits fires.
  writeFileSync(
    path.join(slugDir, "SPEC.md"),
    "# SPEC\n\ncontent v0.1 + user edit\n",
    "utf8",
  );
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(fakeBin, { recursive: true, force: true });
});

function runCli(args: readonly string[]): {
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
    timeout: 15_000,
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? 1,
    elapsedMs: Date.now() - started,
  };
}

describe("samospec iterate --on-dirty (#114)", () => {
  test("dirty + non-TTY + no --on-dirty -> fast exit 1 with actionable message", () => {
    const res = runCli(["iterate", "demo", "--rounds", "1", "--no-push"]);
    expect(res.elapsedMs).toBeLessThan(12_000);
    expect(res.status).not.toBe(0);
    // No readline crash, no deadlock.
    expect(res.stderr).not.toContain("ERR_USE_AFTER_CLOSE");
    expect(res.stderr.toLowerCase()).toContain("--on-dirty");
  });

  test("dirty + --on-dirty abort -> exits cleanly (0) without readline", () => {
    const res = runCli([
      "iterate",
      "demo",
      "--rounds",
      "1",
      "--no-push",
      "--on-dirty",
      "abort",
    ]);
    expect(res.elapsedMs).toBeLessThan(12_000);
    expect(res.stderr).not.toContain("ERR_USE_AFTER_CLOSE");
    expect(res.status).toBe(0);
  });

  test("invalid --on-dirty value -> exit 1 with validation error", () => {
    const res = runCli([
      "iterate",
      "demo",
      "--rounds",
      "1",
      "--no-push",
      "--on-dirty",
      "bogus",
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("--on-dirty");
  });
});
