// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runDoctor } from "../../src/cli/doctor.ts";
import { CheckStatus, formatStatusLine } from "../../src/cli/doctor-format.ts";
import { checkCliAvailability } from "../../src/cli/doctor-checks/availability.ts";
import { checkAuthStatus } from "../../src/cli/doctor-checks/auth.ts";
import { checkGitHealth } from "../../src/cli/doctor-checks/git.ts";
import { checkLockfile } from "../../src/cli/doctor-checks/lock.ts";
import { checkConfig } from "../../src/cli/doctor-checks/config.ts";
import { checkGlobalConfig } from "../../src/cli/doctor-checks/global-config.ts";
import { checkEntropy } from "../../src/cli/doctor-checks/entropy.ts";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import { runInit } from "../../src/cli/init.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-doctor-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// -------- doctor-format helpers --------

describe("doctor-format — status line helper", () => {
  test("emits OK / WARN / FAIL labels with color codes when colors enabled", () => {
    const line = formatStatusLine({
      status: CheckStatus.Ok,
      label: "git",
      message: "repo detected",
      color: true,
    });
    // Must contain the label and message.
    expect(line).toContain("git");
    expect(line).toContain("repo detected");
    // ANSI escape when color=true.
    expect(line).toContain("\u001b[");
    // No emoji.
    expect(line).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  test("plain ASCII when color disabled", () => {
    const line = formatStatusLine({
      status: CheckStatus.Warn,
      label: "auth",
      message: "subscription auth",
      color: false,
    });
    expect(line).not.toContain("\u001b[");
    expect(line.toUpperCase()).toContain("WARN");
  });

  test("FAIL status produces a FAIL token", () => {
    const line = formatStatusLine({
      status: CheckStatus.Fail,
      label: "config",
      message: "malformed",
      color: false,
    });
    expect(line.toUpperCase()).toContain("FAIL");
  });
});

// -------- per-check tests --------

describe("doctor-checks / availability", () => {
  test("reports installed when adapter detect succeeds", async () => {
    const claude = createFakeAdapter({
      detect: { installed: true, version: "1.2.3", path: "/usr/bin/claude" },
    });
    const result = await checkCliAvailability({
      adapters: [{ label: "claude", adapter: claude }],
    });
    expect(result.status).toBe(CheckStatus.Ok);
    expect(result.message).toContain("1.2.3");
    expect(result.message).toContain("/usr/bin/claude");
  });

  test("reports FAIL when adapter detect reports not installed", async () => {
    const codex = createFakeAdapter({
      detect: { installed: false },
    });
    const result = await checkCliAvailability({
      adapters: [{ label: "codex", adapter: codex }],
    });
    expect(result.status).toBe(CheckStatus.Fail);
    expect(result.message.toLowerCase()).toContain("not installed");
  });

  test("aggregates multiple adapters independently", async () => {
    const claude = createFakeAdapter({
      detect: { installed: true, version: "1.0.0", path: "/usr/bin/claude" },
    });
    const codex = createFakeAdapter({
      detect: { installed: false },
    });
    const result = await checkCliAvailability({
      adapters: [
        { label: "claude", adapter: claude },
        { label: "codex", adapter: codex },
      ],
    });
    // Any FAIL rolls up to FAIL.
    expect(result.status).toBe(CheckStatus.Fail);
    expect(result.details?.length ?? 0).toBe(2);
  });
});

describe("doctor-checks / auth", () => {
  test("OK when authenticated with API key", async () => {
    const claude = createFakeAdapter({
      auth: {
        authenticated: true,
        account: "user@example.com",
        subscription_auth: false,
      },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
    });
    expect(result.status).toBe(CheckStatus.Ok);
  });

  test("WARN when authenticated via subscription (surfacing subscription-auth)", async () => {
    const claude = createFakeAdapter({
      auth: {
        authenticated: true,
        subscription_auth: true,
      },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
    });
    expect(result.status).toBe(CheckStatus.Warn);
    expect(result.message.toLowerCase()).toContain("subscription");
    // UX copy per SPEC §11 mentions wall-clock enforcement.
    expect(result.message.toLowerCase()).toMatch(/wall-clock|iteration/);
  });

  test("FAIL when not authenticated", async () => {
    const claude = createFakeAdapter({
      auth: { authenticated: false },
    });
    const result = await checkAuthStatus({
      adapters: [{ label: "claude", adapter: claude }],
    });
    expect(result.status).toBe(CheckStatus.Fail);
  });
});

describe("doctor-checks / git", () => {
  test("OK when inside a git repo with a branch name", () => {
    const result = checkGitHealth({
      isGitRepo: () => true,
      currentBranch: () => "feature/foo",
      hasRemote: () => true,
      remoteUrl: () => "git@github.com:me/repo.git",
      isProtected: () => false,
    });
    expect(result.status).toBe(CheckStatus.Ok);
    expect(result.message).toContain("feature/foo");
  });

  test("WARN when on a protected branch (informational at doctor level)", () => {
    const result = checkGitHealth({
      isGitRepo: () => true,
      currentBranch: () => "main",
      hasRemote: () => false,
      remoteUrl: () => null,
      isProtected: () => true,
    });
    expect(result.status).toBe(CheckStatus.Warn);
    expect(result.message.toLowerCase()).toContain("protected");
  });

  test("FAIL when not inside a git repo", () => {
    const result = checkGitHealth({
      isGitRepo: () => false,
      currentBranch: () => {
        throw new Error("not a repo");
      },
      hasRemote: () => false,
      remoteUrl: () => null,
      isProtected: () => false,
    });
    expect(result.status).toBe(CheckStatus.Fail);
    expect(result.message.toLowerCase()).toMatch(/not a git repo|no git/);
  });
});

describe("doctor-checks / lock", () => {
  test("OK when no .lock file exists", () => {
    mkdirSync(path.join(tmp, ".samo"), { recursive: true });
    const result = checkLockfile({
      lockPath: path.join(tmp, ".samo", ".lock"),
      now: Date.now(),
      maxWallClockMinutes: 240,
    });
    expect(result.status).toBe(CheckStatus.Ok);
    expect(result.message.toLowerCase()).toMatch(/no.*lock|absent|clear/);
  });

  test("WARN when a live lock is held by another process", () => {
    mkdirSync(path.join(tmp, ".samo"), { recursive: true });
    const lockPath = path.join(tmp, ".samo", ".lock");
    const lock = {
      pid: 1, // PID 1 always alive on POSIX.
      started_at: new Date().toISOString(),
      slug: "demo",
    };
    writeFileSync(lockPath, JSON.stringify(lock, null, 2), "utf8");

    const result = checkLockfile({
      lockPath,
      now: Date.now(),
      maxWallClockMinutes: 240,
      isPidAlive: () => true,
    });
    expect(result.status).toBe(CheckStatus.Warn);
    expect(result.message).toContain("1");
    expect(result.message.toLowerCase()).toContain("live");
  });

  test("FAIL when a stale lock is present (dead pid)", () => {
    mkdirSync(path.join(tmp, ".samo"), { recursive: true });
    const lockPath = path.join(tmp, ".samo", ".lock");
    const lock = {
      pid: 99999,
      started_at: new Date().toISOString(),
      slug: "demo",
    };
    writeFileSync(lockPath, JSON.stringify(lock, null, 2), "utf8");

    const result = checkLockfile({
      lockPath,
      now: Date.now(),
      maxWallClockMinutes: 240,
      isPidAlive: () => false,
    });
    expect(result.status).toBe(CheckStatus.Fail);
    expect(result.message.toLowerCase()).toContain("stale");
  });

  test("FAIL when lock is too old (age_exceeded)", () => {
    mkdirSync(path.join(tmp, ".samo"), { recursive: true });
    const lockPath = path.join(tmp, ".samo", ".lock");
    // 400 minutes ago; buffer = 30; max = 240 — expect age_exceeded.
    const now = Date.now();
    const started = new Date(now - 400 * 60_000).toISOString();
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 1, started_at: started, slug: "x" }, null, 2),
      "utf8",
    );

    const result = checkLockfile({
      lockPath,
      now,
      maxWallClockMinutes: 240,
      isPidAlive: () => true,
    });
    expect(result.status).toBe(CheckStatus.Fail);
    expect(result.message.toLowerCase()).toContain("stale");
  });
});

describe("doctor-checks / config", () => {
  test("OK when config.json parses and pinned models match", () => {
    runInit({ cwd: tmp });
    const result = checkConfig({
      configPath: path.join(tmp, ".samo", "config.json"),
    });
    expect(result.status).toBe(CheckStatus.Ok);
  });

  test("FAIL when config.json is missing", () => {
    const result = checkConfig({
      configPath: path.join(tmp, ".samo", "config.json"),
    });
    expect(result.status).toBe(CheckStatus.Fail);
    expect(result.message.toLowerCase()).toMatch(/not found|missing|run.*init/);
  });

  test("FAIL when config.json is malformed", () => {
    mkdirSync(path.join(tmp, ".samo"), { recursive: true });
    writeFileSync(path.join(tmp, ".samo", "config.json"), "{ broken", "utf8");
    const result = checkConfig({
      configPath: path.join(tmp, ".samo", "config.json"),
    });
    expect(result.status).toBe(CheckStatus.Fail);
    expect(result.message.toLowerCase()).toMatch(/malformed|parse|invalid/);
  });

  test("WARN when pinned lead model differs from release metadata", () => {
    runInit({ cwd: tmp });
    // Tamper: set a non-pinned model.
    const cfgPath = path.join(tmp, ".samo", "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<
      string,
      unknown
    >;
    (cfg["adapters"] as Record<string, Record<string, unknown>>)["lead"][
      "model_id"
    ] = "claude-opus-3-5";
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");

    const result = checkConfig({ configPath: cfgPath });
    expect(result.status).toBe(CheckStatus.Warn);
    expect(result.message.toLowerCase()).toMatch(/pinned|mismatch|drift/);
  });
});

describe("doctor-checks / global-config", () => {
  test("OK when none of the global config files exist", () => {
    // Point HOME at an empty temp dir.
    const home = mkdtempSync(path.join(tmpdir(), "samospec-home-"));
    try {
      const result = checkGlobalConfig({ homeDir: home });
      expect(result.status).toBe(CheckStatus.Ok);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("WARN when ~/.claude/CLAUDE.md exists", () => {
    const home = mkdtempSync(path.join(tmpdir(), "samospec-home-"));
    try {
      mkdirSync(path.join(home, ".claude"), { recursive: true });
      writeFileSync(
        path.join(home, ".claude", "CLAUDE.md"),
        "user global prompt",
        "utf8",
      );
      const result = checkGlobalConfig({ homeDir: home });
      expect(result.status).toBe(CheckStatus.Warn);
      expect(result.message).toContain("CLAUDE.md");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("WARN when ~/.codex/preamble.md or instructions.md exists", () => {
    const home = mkdtempSync(path.join(tmpdir(), "samospec-home-"));
    try {
      mkdirSync(path.join(home, ".codex"), { recursive: true });
      writeFileSync(
        path.join(home, ".codex", "instructions.md"),
        "codex global",
        "utf8",
      );
      const result = checkGlobalConfig({ homeDir: home });
      expect(result.status).toBe(CheckStatus.Warn);
      expect(result.message).toContain("instructions.md");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("doctor-checks / entropy", () => {
  test("WARN-level placeholder surfaces the external-scanner recommendation", () => {
    const result = checkEntropy();
    expect(result.status).toBe(CheckStatus.Warn);
    expect(result.message.toLowerCase()).toContain("best-effort");
    expect(result.message.toLowerCase()).toContain("external");
  });
});

// -------- runDoctor integration --------

describe("runDoctor aggregator", () => {
  test("exits 0 when every check is OK or WARN", async () => {
    runInit({ cwd: tmp });
    const fakeHome = mkdtempSync(path.join(tmpdir(), "samospec-home-"));
    try {
      const result = await runDoctor({
        cwd: tmp,
        homeDir: fakeHome,
        adapters: [
          {
            label: "claude",
            adapter: createFakeAdapter({
              auth: {
                authenticated: true,
                account: "u@e.com",
                subscription_auth: false,
              },
            }),
          },
          {
            label: "codex",
            adapter: createFakeAdapter({
              auth: {
                authenticated: true,
                account: "u@e.com",
                subscription_auth: false,
              },
            }),
          },
        ],
        isGitRepo: () => true,
        currentBranch: () => "feature/demo",
        hasRemote: () => false,
        remoteUrl: () => null,
        isProtected: () => false,
        ghRunner: () => ({ status: 0, stdout: "Logged in", stderr: "" }),
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("OK");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("exits 1 when any check FAILs", async () => {
    runInit({ cwd: tmp });
    const fakeHome = mkdtempSync(path.join(tmpdir(), "samospec-home-"));
    try {
      const result = await runDoctor({
        cwd: tmp,
        homeDir: fakeHome,
        adapters: [
          {
            label: "claude",
            adapter: createFakeAdapter({
              detect: { installed: false },
            }),
          },
        ],
        isGitRepo: () => false,
        currentBranch: () => {
          throw new Error("not a repo");
        },
        hasRemote: () => false,
        remoteUrl: () => null,
        isProtected: () => false,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("FAIL");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("surfaces subscription_auth: true explicitly in output", async () => {
    runInit({ cwd: tmp });
    const fakeHome = mkdtempSync(path.join(tmpdir(), "samospec-home-"));
    try {
      const result = await runDoctor({
        cwd: tmp,
        homeDir: fakeHome,
        adapters: [
          {
            label: "claude",
            adapter: createFakeAdapter({
              auth: {
                authenticated: true,
                account: "u@e.com",
                subscription_auth: true,
              },
            }),
          },
        ],
        isGitRepo: () => true,
        currentBranch: () => "feature/demo",
        hasRemote: () => false,
        remoteUrl: () => null,
        isProtected: () => false,
      });
      expect(result.stdout.toLowerCase()).toContain("subscription");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("warns about global-config contamination", async () => {
    runInit({ cwd: tmp });
    const fakeHome = mkdtempSync(path.join(tmpdir(), "samospec-home-"));
    try {
      mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
      writeFileSync(
        path.join(fakeHome, ".claude", "CLAUDE.md"),
        "user global",
        "utf8",
      );

      const result = await runDoctor({
        cwd: tmp,
        homeDir: fakeHome,
        adapters: [
          {
            label: "claude",
            adapter: createFakeAdapter({
              auth: {
                authenticated: true,
                account: "u@e.com",
                subscription_auth: false,
              },
            }),
          },
        ],
        isGitRepo: () => true,
        currentBranch: () => "feature/demo",
        hasRemote: () => false,
        remoteUrl: () => null,
        isProtected: () => false,
      });
      expect(result.stdout).toContain("CLAUDE.md");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("NO_COLOR env suppresses ANSI in stdout", async () => {
    runInit({ cwd: tmp });
    const fakeHome = mkdtempSync(path.join(tmpdir(), "samospec-home-"));
    try {
      const result = await runDoctor({
        cwd: tmp,
        homeDir: fakeHome,
        adapters: [
          {
            label: "claude",
            adapter: createFakeAdapter({
              auth: {
                authenticated: true,
                account: "u@e.com",
                subscription_auth: false,
              },
            }),
          },
        ],
        isGitRepo: () => true,
        currentBranch: () => "feature/demo",
        hasRemote: () => false,
        remoteUrl: () => null,
        isProtected: () => false,
        env: { NO_COLOR: "1" },
      });
      expect(result.stdout).not.toContain("\u001b[");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
