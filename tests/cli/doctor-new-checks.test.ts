// Copyright 2026 Nikolay Samokhvalov.

/**
 * Tests for the three NEW doctor checks added in Issue #34:
 *   - push-consent status per remote
 *   - calibration state
 *   - PR-open capability (gh/glab presence + auth)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CheckStatus } from "../../src/cli/doctor-format.ts";
import { checkPushConsent } from "../../src/cli/doctor-checks/push-consent.ts";
import { checkCalibration } from "../../src/cli/doctor-checks/calibration.ts";
import { checkPrCapability } from "../../src/cli/doctor-checks/pr-capability.ts";
import { persistConsent } from "../../src/git/push-consent.ts";
import { runInit } from "../../src/cli/init.ts";
import { writeCalibrationSample } from "../../src/policy/calibration.ts";
import { CALIBRATION_FLOOR } from "../../src/policy/calibration.ts";
import { runDoctor } from "../../src/cli/doctor.ts";
import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-dr-new-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── push-consent ──────────────────────────────────────────────────────────

describe("doctor-checks / push-consent", () => {
  test("WARN when no remotes configured", () => {
    const result = checkPushConsent({ repoPath: tmp, remotes: [] });
    expect(result.status).toBe(CheckStatus.Warn);
    expect(result.label).toBe("push-consent");
  });

  test("OK when at least one remote has accepted consent", () => {
    runInit({ cwd: tmp });
    const url = "git@github.com:org/repo.git";
    persistConsent({ repoPath: tmp, remoteUrl: url, granted: true });

    const result = checkPushConsent({
      repoPath: tmp,
      remotes: [{ name: "origin", url }],
    });
    expect(result.status).toBe(CheckStatus.Ok);
    expect(result.message).toContain("OK");
  });

  test("WARN when remote consent is REFUSED", () => {
    runInit({ cwd: tmp });
    const url = "git@github.com:org/repo.git";
    persistConsent({ repoPath: tmp, remoteUrl: url, granted: false });

    const result = checkPushConsent({
      repoPath: tmp,
      remotes: [{ name: "origin", url }],
    });
    expect(result.status).toBe(CheckStatus.Warn);
    expect(result.message).toContain("REFUSED");
  });

  test("WARN when consent NOT YET PROMPTED (no config entry)", () => {
    runInit({ cwd: tmp });
    const url = "git@github.com:org/repo.git";
    // No persistConsent call.
    const result = checkPushConsent({
      repoPath: tmp,
      remotes: [{ name: "origin", url }],
    });
    expect(result.status).toBe(CheckStatus.Warn);
    expect(result.message).toContain("NOT YET PROMPTED");
  });

  test("details array lists each remote with its status", () => {
    runInit({ cwd: tmp });
    const url1 = "git@github.com:org/repo.git";
    const url2 = "git@github.com:org/fork.git";
    persistConsent({ repoPath: tmp, remoteUrl: url1, granted: true });
    persistConsent({ repoPath: tmp, remoteUrl: url2, granted: false });

    const result = checkPushConsent({
      repoPath: tmp,
      remotes: [
        { name: "origin", url: url1 },
        { name: "upstream", url: url2 },
      ],
    });
    // Mixed: one OK, one REFUSED → WARN overall.
    expect(result.status).toBe(CheckStatus.Warn);
    expect(result.details).toBeDefined();
    const details = result.details as string[];
    expect(details.length).toBe(2);
    expect(details[0]).toContain("origin");
    expect(details[0]).toContain("OK");
    expect(details[1]).toContain("upstream");
    expect(details[1]).toContain("REFUSED");
  });
});

// ─── calibration ───────────────────────────────────────────────────────────

describe("doctor-checks / calibration", () => {
  test("WARN when config.json is missing", () => {
    const result = checkCalibration({
      configPath: path.join(tmp, ".samo", "config.json"),
    });
    expect(result.status).toBe(CheckStatus.Warn);
    expect(result.label).toBe("calibration");
  });

  test("WARN when calibration block is absent (fresh init)", () => {
    runInit({ cwd: tmp });
    // Fresh init has no calibration block yet.
    const result = checkCalibration({
      configPath: path.join(tmp, ".samo", "config.json"),
    });
    expect(result.status).toBe(CheckStatus.Warn);
    expect(result.message.toLowerCase()).toContain("approximate");
  });

  test("WARN when sample_count < 3 (below floor)", () => {
    runInit({ cwd: tmp });
    // Write 2 samples — below CALIBRATION_FLOOR (3).
    for (let i = 0; i < 2; i++) {
      writeCalibrationSample({
        cwd: tmp,
        session_actual_tokens: 1000,
        session_actual_cost_usd: 0.05,
        session_rounds: 3,
      });
    }
    const result = checkCalibration({
      configPath: path.join(tmp, ".samo", "config.json"),
    });
    expect(result.status).toBe(CheckStatus.Warn);
    expect(result.message).toContain("approximate");
    expect(result.message).toContain("2");
  });

  test("OK when sample_count >= 3 (at or above floor)", () => {
    runInit({ cwd: tmp });
    for (let i = 0; i < CALIBRATION_FLOOR; i++) {
      writeCalibrationSample({
        cwd: tmp,
        session_actual_tokens: 1000,
        session_actual_cost_usd: 0.05,
        session_rounds: 3,
      });
    }
    const result = checkCalibration({
      configPath: path.join(tmp, ".samo", "config.json"),
    });
    expect(result.status).toBe(CheckStatus.Ok);
    expect(result.message).toContain(String(CALIBRATION_FLOOR));
  });

  test("reports 'blended' label for sample_count 3-10", () => {
    runInit({ cwd: tmp });
    for (let i = 0; i < 5; i++) {
      writeCalibrationSample({
        cwd: tmp,
        session_actual_tokens: 1000,
        session_actual_cost_usd: 0.05,
        session_rounds: 3,
      });
    }
    const result = checkCalibration({
      configPath: path.join(tmp, ".samo", "config.json"),
    });
    expect(result.status).toBe(CheckStatus.Ok);
    expect(result.message.toLowerCase()).toContain("blended");
  });

  test("reports 'dominated' label for sample_count > 10", () => {
    runInit({ cwd: tmp });
    for (let i = 0; i < 11; i++) {
      writeCalibrationSample({
        cwd: tmp,
        session_actual_tokens: 1000,
        session_actual_cost_usd: 0.05,
        session_rounds: 3,
      });
    }
    const result = checkCalibration({
      configPath: path.join(tmp, ".samo", "config.json"),
    });
    expect(result.status).toBe(CheckStatus.Ok);
    expect(result.message.toLowerCase()).toContain("dominated");
  });
});

// ─── pr-capability ─────────────────────────────────────────────────────────

describe("doctor-checks / pr-capability", () => {
  test("FAIL when neither gh nor glab is installed", () => {
    const result = checkPrCapability({
      gh: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      glab: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    expect(result.status).toBe(CheckStatus.Fail);
    expect(result.label).toBe("pr-capability");
    expect(result.message.toLowerCase()).toMatch(/not found|gh.*glab/);
  });

  test("WARN when gh is installed but auth status returns non-zero", () => {
    const result = checkPrCapability({
      gh: () => ({ status: 1, stdout: "", stderr: "Not logged in" }),
      glab: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    expect(result.status).toBe(CheckStatus.Warn);
    expect(result.message.toLowerCase()).toContain("not authenticated");
  });

  test("OK when gh is authenticated", () => {
    const result = checkPrCapability({
      gh: () => ({ status: 0, stdout: "Logged in", stderr: "" }),
      glab: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    expect(result.status).toBe(CheckStatus.Ok);
    expect(result.message).toContain("gh");
  });

  test("OK when glab is authenticated (gh not installed)", () => {
    const result = checkPrCapability({
      gh: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      glab: () => ({ status: 0, stdout: "Logged in", stderr: "" }),
    });
    expect(result.status).toBe(CheckStatus.Ok);
    expect(result.message).toContain("glab");
  });

  test("OK prefers gh when both are authenticated", () => {
    const result = checkPrCapability({
      gh: () => ({ status: 0, stdout: "Logged in", stderr: "" }),
      glab: () => ({ status: 0, stdout: "Logged in", stderr: "" }),
    });
    expect(result.status).toBe(CheckStatus.Ok);
    expect(result.message).toContain("gh");
  });
});

// ─── runDoctor integration with new checks ─────────────────────────────────

describe("runDoctor — new checks wired into aggregator", () => {
  test("all new checks surface in doctor output", async () => {
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
        remotes: [],
        ghRunner: () => ({ status: 0, stdout: "Logged in", stderr: "" }),
        glabRunner: () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
      });
      // All three new checks should appear.
      expect(result.stdout).toContain("push-consent");
      expect(result.stdout).toContain("calibration");
      expect(result.stdout).toContain("pr-capability");
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
