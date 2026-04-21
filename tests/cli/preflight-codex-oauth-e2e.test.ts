// Copyright 2026 Nikolay Samokhvalov.

// RED e2e CLI tests for #80 — when `OPENAI_API_KEY` is absent in the
// spawned process environment (ChatGPT OAuth mode), the `samospec new`
// preflight must show `unknown — OAuth` for reviewer_a, NOT a dollar
// estimate such as `$1.88`.
//
// The bug: `runPreflight()` in src/cli/new.ts hardcodes
// `subscription_auth: false` for reviewer_a regardless of what
// `CodexAdapter.auth_status()` returns. Unit tests (preflight-codex-
// oauth.test.ts) pass because they inject subscription_auth directly;
// the CLI never actually calls auth_status() for reviewer_a.
//
// Fix: query the reviewer_a adapter's auth_status() and forward the
// result into runPreflight so computePreflight sees the correct flag.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI_PATH = path.resolve(import.meta.dir, "..", "..", "src", "main.ts");

let tmp: string;
let fakeBinDir: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-preflight-e2e-"));
  fakeBinDir = mkdtempSync(path.join(tmpdir(), "samospec-fakebin-e2e-"));

  // Create a real git repo on a non-protected branch so new can proceed.
  spawnSync("git", ["init", "--initial-branch", "work", tmp], {
    encoding: "utf8",
    env: { ...process.env },
  });
  spawnSync("git", ["commit", "--allow-empty", "-m", "chore: init"], {
    cwd: tmp,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });

  // Set up fake claude binary. It must handle:
  //   1. `claude --version` → version string (for detect)
  //   2. `claude -p <flags> ...` → valid persona JSON (for ask)
  //   3. subsequent calls → valid structured JSON
  // We use a simple bun script wrapper around fake-cli.ts.
  const fakeClaude = path.join(fakeBinDir, "claude");
  writeFileSync(
    fakeClaude,
    // Return a valid persona JSON for all non-version calls so that
    // `samospec new` can complete past the preflight + persona stages.
    `#!/usr/bin/env bash
if [[ "$1" == "--version" ]]; then
  echo "1.0.0"
  exit 0
fi
# For any work call: emit valid persona JSON (ask call).
echo '{"persona":"Veteran \\"spec\\" expert","rationale":"test","usage":null,"effort_used":"max"}'
exit 0
`,
  );
  chmodSync(fakeClaude, 0o755);

  // Create fake codex binary. It only needs to handle `--version`
  // (for auth_status / detect). It is NOT called during `samospec new`
  // (only during `iterate`), but it must be on PATH so the adapter
  // sees it as installed and returns authenticated: true.
  const fakeCodex = path.join(fakeBinDir, "codex");
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env bash
echo "0.1.0"
exit 0
`,
  );
  chmodSync(fakeCodex, 0o755);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(fakeBinDir, { recursive: true, force: true });
});

function runSamospecNew(slug: string): {
  stdout: string;
  stderr: string;
  status: number;
} {
  const bun = Bun.argv[0];
  // Build minimal env: inject fake bins first in PATH, remove API keys.
  const baseEnv = { ...process.env };
  delete baseEnv["OPENAI_API_KEY"];
  // We keep ANTHROPIC_API_KEY absent too, but claude may be subscription.
  // The key check is: OPENAI_API_KEY is absent → reviewer_a OAuth.
  const env: Record<string, string> = {
    ...baseEnv,
    PATH: `${fakeBinDir}:${baseEnv["PATH"] ?? "/usr/bin:/bin"}`,
    NO_COLOR: "1",
    HOME: tmp,
  } as Record<string, string>;
  // Ensure OPENAI_API_KEY is truly absent (delete any residual).
  delete env["OPENAI_API_KEY"];

  // Run with a timeout; the preflight is printed before any AI call,
  // so even if the process later fails it will have already emitted it.
  const result = spawnSync(
    bun,
    ["run", CLI_PATH, "new", slug, "--idea", "test"],
    {
      cwd: tmp,
      encoding: "utf8",
      env,
      // Pipe "\n" answers for any interactive prompts; timeout after 20s.
      input: "\n\n\n\n\n",
      timeout: 20_000,
    },
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

// Helper: find the reviewer_a line in the per-adapter block.
function findReviewerALine(stdout: string): string | null {
  const lines = stdout.split("\n");
  for (const line of lines) {
    if (line.includes("reviewer_a")) return line;
  }
  return null;
}

// RED: must fail on current main because runPreflight hardcodes
// subscription_auth: false for reviewer_a.
describe("#80 — e2e CLI: samospec new preflight reviewer_a under ChatGPT OAuth", () => {
  test("reviewer_a preflight line contains 'unknown — OAuth'", () => {
    // samospec init first (need config.json for preflight).
    const bun = Bun.argv[0];
    const baseEnv = { ...process.env };
    delete baseEnv["OPENAI_API_KEY"];
    const initEnv = {
      ...baseEnv,
      PATH: `${fakeBinDir}:${baseEnv["PATH"] ?? "/usr/bin:/bin"}`,
      NO_COLOR: "1",
      HOME: tmp,
    } as Record<string, string>;
    spawnSync(bun, ["run", CLI_PATH, "init", "--yes"], {
      cwd: tmp,
      encoding: "utf8",
      env: initEnv,
      timeout: 15_000,
    });
    expect(existsSync(path.join(tmp, ".samo", "config.json"))).toBe(true);

    const result = runSamospecNew("demo");

    // Extract the reviewer_a line from stdout.
    const reviewerLine = findReviewerALine(result.stdout);
    expect(reviewerLine).not.toBeNull();

    // KEY assertion: must say "OAuth" (not a dollar amount).
    expect(reviewerLine).toContain("OAuth");
  });

  test("reviewer_a preflight line does NOT contain a dollar amount", () => {
    const bun = Bun.argv[0];
    const baseEnv = { ...process.env };
    delete baseEnv["OPENAI_API_KEY"];
    const initEnv = {
      ...baseEnv,
      PATH: `${fakeBinDir}:${baseEnv["PATH"] ?? "/usr/bin:/bin"}`,
      NO_COLOR: "1",
      HOME: tmp,
    } as Record<string, string>;
    spawnSync(bun, ["run", CLI_PATH, "init", "--yes"], {
      cwd: tmp,
      encoding: "utf8",
      env: initEnv,
      timeout: 15_000,
    });

    const result = runSamospecNew("demo");

    const reviewerLine = findReviewerALine(result.stdout);
    expect(reviewerLine).not.toBeNull();

    // Must NOT contain a dollar price like "$1.88".
    expect(reviewerLine).not.toMatch(/\$\d+\.\d+/);
  });
});
