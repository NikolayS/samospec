// Copyright 2026 Nikolay Samokhvalov.

// Historically (#81) this test asserted that
// `samospec new --max-session-wall-clock-ms <ms>` capped a hanging
// session and exited within ~ms with `session-wall-clock` in stderr.
// That kill was removed per Rule 10 and samo.team #415 + #424. The
// flag remains parseable for backward compatibility but is a no-op.
//
// Tests below assert:
//   1. USAGE still documents the flag (so existing scripts that grep
//      for it on `--help` don't break).
//   2. With the flag set and a hanging stub `claude` binary on PATH,
//      the CLI does NOT exit cleanly within the cap — it only exits
//      because the spawnSync subprocess timeout kills it (status null
//      or the spawned bun runtime got SIGTERM). stderr does NOT
//      contain `session-wall-clock`.
//   3. The equals form `--max-session-wall-clock-ms=<ms>` parses the
//      same way (same behavior assertion).
//   4. Non-integer value still rejected with exit 1 (the parser
//      validation didn't change).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI_PATH = path.resolve(import.meta.dir, "..", "..", "src", "main.ts");

let tmp: string;
let fakeHome: string;
let fakeBin: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-wallclock-cli-"));
  fakeHome = mkdtempSync(path.join(tmpdir(), "samospec-wallclock-home-"));
  fakeBin = mkdtempSync(path.join(tmpdir(), "samospec-wallclock-bin-"));

  // Write a hanging fake `claude` binary: sleeps forever on any invocation.
  const claudeStub = path.join(fakeBin, "claude");
  writeFileSync(claudeStub, "#!/bin/sh\nsleep 3600\n");
  chmodSync(claudeStub, 0o755);

  // Also stub `codex` so reviewer_a preflight doesn't error out before
  // the lead phase starts.
  const codexStub = path.join(fakeBin, "codex");
  writeFileSync(
    codexStub,
    "#!/bin/sh\n" +
      'if [ "$1" = "--version" ]; then echo "0.0.0-fake"; exit 0; fi\n' +
      "sleep 3600\n",
  );
  chmodSync(codexStub, 0o755);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(fakeBin, { recursive: true, force: true });
});

function runSamospec(
  args: readonly string[],
  opts: { cwd: string; timeoutMs?: number } = { cwd: tmp },
): {
  stdout: string;
  stderr: string;
  status: number | null;
  elapsedMs: number;
} {
  const env: Record<string, string> = {
    PATH: `${fakeBin}:/bin:/usr/bin:/usr/local/bin`,
    HOME: fakeHome,
    NO_COLOR: "1",
    ANTHROPIC_API_KEY: "sk-fake-test-key",
  };
  const bun = Bun.argv[0];
  const startMs = Date.now();
  const result = spawnSync(bun, ["run", CLI_PATH, ...(args as string[])], {
    cwd: opts.cwd,
    encoding: "utf8",
    env,
    timeout: opts.timeoutMs ?? 15_000,
  });
  const elapsedMs = Date.now() - startMs;
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    elapsedMs,
  };
}

describe("samospec new --max-session-wall-clock-ms (CLI flag, #81 / samo.team #415, #424)", () => {
  test("USAGE string still documents --max-session-wall-clock-ms", () => {
    const res = runSamospec([], { cwd: tmp, timeoutMs: 8_000 });
    expect(res.stderr.toLowerCase()).toContain("--max-session-wall-clock-ms");
  });

  test("--max-session-wall-clock-ms 1500 does NOT preempt a hanging session", () => {
    // Init the repo (git + .samo/).
    spawnSync("git", ["init", "--initial-branch", "feature/wc-e2e", tmp], {
      cwd: tmpdir(),
      encoding: "utf8",
    });
    const initRes = runSamospec(["init"], { cwd: tmp, timeoutMs: 8_000 });
    expect(initRes.status).toBe(0);

    // Run `samospec new demo --max-session-wall-clock-ms 1500` with
    // the hanging `claude` stub on PATH and `--yes` so we pass the
    // non-TTY gate. Pre-fix this would exit ~1.5s with a
    // `session-wall-clock exceeded` error in stderr. Post-fix the CLI
    // keeps running until the spawnSync subprocess timeout kills the
    // whole bun process tree (status === null, the
    // subprocess-timeout signal).
    const res = runSamospec(
      [
        "new",
        "demo",
        "--idea",
        "cli flag test",
        "--yes",
        "--max-session-wall-clock-ms",
        "1500",
      ],
      { cwd: tmp, timeoutMs: 5_000 },
    );

    // The CLI must NOT have produced the kill-error message. The USAGE
    // text DOES mention `--max-session-wall-clock-ms` as a deprecated
    // flag, so we look for the distinctive runtime kill phrase
    // ("session-wall-clock exceeded") rather than a substring of the
    // flag name.
    expect(res.stderr.toLowerCase()).not.toContain(
      "session-wall-clock exceeded",
    );
    // Subprocess was killed by spawnSync timeout (status === null) or
    // exited with a non-zero non-4 status — either way, NOT a
    // wall-clock self-kill.
    expect(res.status).not.toBe(4);
    // It must have run for at least the subprocess timeout (the cap
    // is a no-op, so the run does not self-terminate).
    expect(res.elapsedMs).toBeGreaterThanOrEqual(4_500);
  }, 20_000);

  test("--max-session-wall-clock-ms=1500 (equals form) is also a no-op", () => {
    spawnSync("git", ["init", "--initial-branch", "feature/wc-eq", tmp], {
      cwd: tmpdir(),
      encoding: "utf8",
    });
    const initRes = runSamospec(["init"], { cwd: tmp, timeoutMs: 8_000 });
    expect(initRes.status).toBe(0);

    const res = runSamospec(
      [
        "new",
        "demo-eq",
        "--idea",
        "eq form test",
        "--yes",
        "--max-session-wall-clock-ms=1500",
      ],
      { cwd: tmp, timeoutMs: 5_000 },
    );

    expect(res.stderr.toLowerCase()).not.toContain(
      "session-wall-clock exceeded",
    );
    expect(res.status).not.toBe(4);
    expect(res.elapsedMs).toBeGreaterThanOrEqual(4_500);
  }, 20_000);

  test("--max-session-wall-clock-ms with non-integer value rejects with exit 1", () => {
    spawnSync("git", ["init", "--initial-branch", "feature/wc-bad", tmp], {
      cwd: tmpdir(),
      encoding: "utf8",
    });
    const initRes = runSamospec(["init"], { cwd: tmp, timeoutMs: 8_000 });
    expect(initRes.status).toBe(0);

    const res = runSamospec(
      [
        "new",
        "demo-bad",
        "--idea",
        "bad value",
        "--max-session-wall-clock-ms",
        "not-a-number",
      ],
      { cwd: tmp, timeoutMs: 8_000 },
    );
    expect(res.status).toBe(1);
    // Error must name the flag so the user can diagnose.
    expect(res.stderr.toLowerCase()).toContain("max-session-wall-clock-ms");
  });
});
