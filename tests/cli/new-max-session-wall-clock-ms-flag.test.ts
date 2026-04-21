// Copyright 2026 Nikolay Samokhvalov.

// CLI-level e2e for `--max-session-wall-clock-ms` (#81, PR #83 review).
//
// The runtime plumbing in src/cli/new.ts already honors
// `RunNewInput.maxSessionWallClockMs`, but the CLI parser in src/cli.ts
// must also accept `--max-session-wall-clock-ms <ms>` (or `=ms`) and
// thread the value into `runNew`. Without the parser change users
// running `samospec new demo --max-session-wall-clock-ms 5000` would
// fall back to the 10-minute default — the exact "unit tests pass, CLI
// never invokes" pattern that bit #79/#80.
//
// Strategy: spawn a real `bun run src/main.ts new <slug>` in a tmpdir
// with a stub `claude` binary on PATH that hangs forever. With a 5s
// cap, the command MUST terminate within ~7s and stderr MUST contain
// `session-wall-clock`. The pre-fix CLI ignores the flag; the hang
// would fall back to the 10-min default → test times out.

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
): { stdout: string; stderr: string; status: number; elapsedMs: number } {
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
    status: result.status ?? 1,
    elapsedMs,
  };
}

describe("samospec new --max-session-wall-clock-ms (CLI flag, #81)", () => {
  test("USAGE string documents --max-session-wall-clock-ms", () => {
    const res = runSamospec([], { cwd: tmp, timeoutMs: 8_000 });
    expect(res.stderr.toLowerCase()).toContain("--max-session-wall-clock-ms");
  });

  test("--max-session-wall-clock-ms 5000 caps a hanging session to ~5s", () => {
    // Init the repo (git + .samo/).
    spawnSync("git", ["init", "--initial-branch", "feature/wc-e2e", tmp], {
      cwd: tmpdir(),
      encoding: "utf8",
    });
    const initRes = runSamospec(["init"], { cwd: tmp, timeoutMs: 8_000 });
    expect(initRes.status).toBe(0);

    // Now run `samospec new demo --max-session-wall-clock-ms 5000`
    // with the hanging `claude` stub on PATH. Must exit within ~7s.
    const startMs = Date.now();
    const res = runSamospec(
      [
        "new",
        "demo",
        "--idea",
        "cli flag test",
        "--max-session-wall-clock-ms",
        "5000",
      ],
      { cwd: tmp, timeoutMs: 12_000 },
    );
    const elapsedMs = Date.now() - startMs;

    // Must terminate within 10s (gives ~5s cap + overhead).
    expect(elapsedMs).toBeLessThan(10_000);

    // Must exit with non-zero (4 from runNew, or 1 from parser) and
    // stderr must mention session-wall-clock.
    expect(res.status).not.toBe(0);
    expect(res.stderr.toLowerCase()).toContain("session-wall-clock");
  }, 20_000);

  test("--max-session-wall-clock-ms=5000 (equals form) also caps a hanging session", () => {
    spawnSync("git", ["init", "--initial-branch", "feature/wc-eq", tmp], {
      cwd: tmpdir(),
      encoding: "utf8",
    });
    const initRes = runSamospec(["init"], { cwd: tmp, timeoutMs: 8_000 });
    expect(initRes.status).toBe(0);

    const startMs = Date.now();
    const res = runSamospec(
      [
        "new",
        "demo-eq",
        "--idea",
        "eq form test",
        "--max-session-wall-clock-ms=5000",
      ],
      { cwd: tmp, timeoutMs: 12_000 },
    );
    const elapsedMs = Date.now() - startMs;

    expect(elapsedMs).toBeLessThan(10_000);
    expect(res.status).not.toBe(0);
    expect(res.stderr.toLowerCase()).toContain("session-wall-clock");
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
