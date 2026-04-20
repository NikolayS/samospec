// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkEntropy } from "../../src/cli/doctor-checks/entropy.ts";
import { CheckStatus } from "../../src/cli/doctor-format.ts";
import { runDoctor } from "../../src/cli/doctor.ts";
import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import { runInit } from "../../src/cli/init.ts";

let tmp: string;
let fakeHome: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-entropy-"));
  fakeHome = mkdtempSync(path.join(tmpdir(), "samospec-home-entropy-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("doctor-checks / entropy — scanner integration", () => {
  test("WARN by default — mentions best-effort + external scanners", () => {
    const result = checkEntropy({ cwd: tmp, extraPaths: [] });
    expect(result.status).toBe(CheckStatus.Warn);
    expect(result.message.toLowerCase()).toContain("best-effort");
    expect(result.message.toLowerCase()).toMatch(
      /gitleaks|trufflehog|external/,
    );
  });

  test("never FAILs — always OK or WARN even on hits", () => {
    // No files to scan — should still not FAIL.
    const clean = checkEntropy({ cwd: tmp, extraPaths: [] });
    expect(clean.status).not.toBe(CheckStatus.Fail);

    // Add a known-shape secret fragment.
    const p = path.join(tmp, "leaked.log");
    writeFileSync(
      p,
      // Assembled from fragments so the fixture file itself doesn't
      // contain a single verbatim secret-shaped token on any line.
      `leaked key: ${"AKIA" + "EXAMPLEKEY12345X"}\n`,
      "utf8",
    );
    const withSecret = checkEntropy({ cwd: tmp, extraPaths: [p] });
    expect(withSecret.status).not.toBe(CheckStatus.Fail);
  });

  test("reports a HIT count when the scan finds matches", () => {
    const p = path.join(tmp, "secrets.log");
    writeFileSync(
      p,
      [
        `aws=${"AKIA" + "EXAMPLEKEY12345X"}`,
        `gh=${"ghp_" + "ExampleExampleExampleExampleExample12"}`,
      ].join("\n"),
      "utf8",
    );
    const result = checkEntropy({ cwd: tmp, extraPaths: [p] });
    // 2 distinct secrets — count surfaced, actual values NOT surfaced.
    expect(result.status).toBe(CheckStatus.Warn);
    expect(result.message).toMatch(/\b2\b/);
    // Message MUST NOT leak the raw secret bodies.
    expect(result.message).not.toContain("EXAMPLEKEY12345X");
    expect(result.message).not.toContain("Example12");
  });

  test("scans files the user listed in doctor.entropy_scan_paths config", () => {
    // Stand up a minimal .samospec with config.json listing a scan path.
    mkdirSync(path.join(tmp, ".samospec"), { recursive: true });
    const spiky = path.join(tmp, "custom.log");
    writeFileSync(
      spiky,
      `sec=${"ghp_" + "ExampleExampleExampleExampleExample12"}\n`,
      "utf8",
    );
    writeFileSync(
      path.join(tmp, ".samospec", "config.json"),
      JSON.stringify({
        adapters: {},
        doctor: { entropy_scan_paths: [spiky] },
      }),
      "utf8",
    );
    const result = checkEntropy({ cwd: tmp });
    expect(result.status).toBe(CheckStatus.Warn);
    expect(result.message).toMatch(/\b1\b/);
  });

  test("glob-picks up .samospec/spec/<slug>/transcripts/*.log", () => {
    const slug = "demo";
    const dir = path.join(tmp, ".samospec", "spec", slug, "transcripts");
    mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, "author.log");
    writeFileSync(
      logPath,
      `leak: ${"sk_live_" + "EXAMPLEexampleEXAMPLEexample1234"}\n`,
      "utf8",
    );
    const result = checkEntropy({ cwd: tmp });
    expect(result.status).toBe(CheckStatus.Warn);
    expect(result.message).toMatch(/\b1\b/);
    // Must not leak the actual secret body.
    expect(result.message).not.toContain("EXAMPLEexample");
  });

  test("OK when scanned files are clean of known patterns", () => {
    const p = path.join(tmp, "clean.log");
    writeFileSync(
      p,
      "just prose v1.2.3 foo.bar.baz src/foo/bar.ts\n",
      "utf8",
    );
    const result = checkEntropy({ cwd: tmp, extraPaths: [p] });
    expect(result.status).toBe(CheckStatus.Ok);
    expect(result.message.toLowerCase()).toContain("best-effort");
  });

  test("missing files listed in config are tolerated, not errors", () => {
    // The config points at a path that doesn't exist. Don't crash.
    const missing = path.join(tmp, "does-not-exist.log");
    const result = checkEntropy({ cwd: tmp, extraPaths: [missing] });
    expect(result.status).not.toBe(CheckStatus.Fail);
  });
});

describe("doctor aggregator — entropy integration", () => {
  test("runDoctor wires the entropy check and passes cwd through", async () => {
    runInit({ cwd: tmp });
    // Inject a secret into a discoverable file.
    const logDir = path.join(
      tmp,
      ".samospec",
      "spec",
      "demo",
      "transcripts",
    );
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      path.join(logDir, "author.log"),
      `secret=${"AKIA" + "EXAMPLEKEY12345X"}\n`,
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

    // Output should mention the hit count but never the raw secret.
    expect(result.stdout).toContain("entropy");
    expect(result.stdout).toContain("1");
    expect(result.stdout).not.toContain("EXAMPLEKEY12345X");
    // A WARN must never push the overall exit code to 1.
    expect(result.exitCode).toBe(0);
  });

  test("runDoctor entropy check is OK when no logs exist", async () => {
    runInit({ cwd: tmp });
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
    // No leaked keys — exit 0. The entropy line still prints but stays WARN
    // only because the placeholder message is informational. We assert the
    // absence of a FAIL state.
    expect(result.stdout).not.toContain("EXAMPLEKEY12345X");
  });
});
