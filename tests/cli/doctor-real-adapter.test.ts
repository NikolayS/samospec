// Copyright 2026 Nikolay Samokhvalov.

/**
 * Regression tests asserting that `samospec doctor` uses real adapters
 * (ClaudeAdapter + CodexAdapter), not the Sprint 1 FakeAdapter stub.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";

import { runDoctor } from "../../src/cli/doctor.ts";
import { runInit } from "../../src/cli/init.ts";
import { ClaudeAdapter } from "../../src/adapter/claude.ts";
import { CodexAdapter } from "../../src/adapter/codex.ts";

let tmp: string;
let fakeHome: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-real-adapter-"));
  fakeHome = mkdtempSync(
    path.join(tmpdir(), "samospec-home-real-adapter-"),
  );
  runInit({ cwd: tmp });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

// ─── helper: build a shimmed PATH directory ─────────────────────────────────

function makeShimDir(
  shims: Record<string, string>,
): { shimDir: string; cleanUp: () => void } {
  const shimDir = mkdtempSync(path.join(tmpdir(), "samospec-shim-"));
  for (const [name, script] of Object.entries(shims)) {
    const p = path.join(shimDir, name);
    writeFileSync(p, script, { mode: 0o755 });
    chmodSync(p, 0o755);
  }
  return {
    shimDir,
    cleanUp: () => rmSync(shimDir, { recursive: true, force: true }),
  };
}

// ─── Test 1: PATH shim emitting real-looking version ────────────────────────

describe("doctor-real-adapter / Test 1: PATH shim with real-looking version", () => {
  test(
    "output reports installed binary path from shim, not fake-1.0.0",
    async () => {
      // Shim claude and codex as real-looking executables.
      // ClaudeAdapter parses the version from stdout; if it can extract a
      // semver token, it uses that; otherwise it falls back to the first
      // line. Either way the INSTALLED status and real PATH are reported
      // (not fake-1.0.0 / /usr/bin/fake).
      const claudeVersion = "2.1.114";
      const codexVersion = "0.120.0";

      const { shimDir, cleanUp } = makeShimDir({
        claude: `#!/bin/sh\necho "${claudeVersion} (Claude Code)"\n`,
        codex: `#!/bin/sh\nprintf "codex-cli ${codexVersion}\\n"\n`,
      });

      try {
        // Build adapters with the shimmed PATH only (no system PATH).
        const shimmedEnv: Record<string, string | undefined> = {
          PATH: shimDir,
          HOME: fakeHome,
        };
        const claudeAdapter = new ClaudeAdapter({ host: shimmedEnv });
        const codexAdapter = new CodexAdapter({ host: shimmedEnv });

        const result = await runDoctor({
          cwd: tmp,
          homeDir: fakeHome,
          adapters: [
            { label: "claude", adapter: claudeAdapter },
            { label: "codex", adapter: codexAdapter },
          ],
          isGitRepo: () => true,
          currentBranch: () => "feature/test",
          hasRemote: () => false,
          remoteUrl: () => null,
          isProtected: () => false,
          ghRunner: () => ({ status: 0, stdout: "Logged in", stderr: "" }),
        });

        // The real adapter must report the actual shim path.
        expect(result.stdout).toContain(shimDir);
        // Must NOT contain the fake stub data.
        expect(result.stdout).not.toContain("fake-1.0.0");
        expect(result.stdout).not.toContain("/usr/bin/fake");
        expect(result.stdout).not.toContain("fake@example.com");
      } finally {
        cleanUp();
      }
    },
  );
});

// ─── Test 2: empty PATH → both not installed ─────────────────────────────────

describe("doctor-real-adapter / Test 2: empty PATH reports not installed", () => {
  test(
    "with no claude/codex on PATH, output reports not installed (not fake-1.0.0)",
    async () => {
      // Create an empty PATH directory (no binaries inside).
      const emptyDir = mkdtempSync(
        path.join(tmpdir(), "samospec-empty-path-"),
      );
      try {
        const emptyEnv: Record<string, string | undefined> = {
          PATH: emptyDir,
        };
        const claudeAdapter = new ClaudeAdapter({ host: emptyEnv });
        const codexAdapter = new CodexAdapter({ host: emptyEnv });

        const result = await runDoctor({
          cwd: tmp,
          homeDir: fakeHome,
          adapters: [
            { label: "claude", adapter: claudeAdapter },
            { label: "codex", adapter: codexAdapter },
          ],
          isGitRepo: () => true,
          currentBranch: () => "feature/test",
          hasRemote: () => false,
          remoteUrl: () => null,
          isProtected: () => false,
          ghRunner: () => ({ status: 0, stdout: "Logged in", stderr: "" }),
        });

        // Must report not installed.
        expect(result.stdout.toLowerCase()).toContain("not installed");
        // Must NOT report fake stub data.
        expect(result.stdout).not.toContain("fake-1.0.0");
        expect(result.stdout).not.toContain("/usr/bin/fake");
        expect(result.stdout).not.toContain("fake@example.com");
      } finally {
        rmSync(emptyDir, { recursive: true, force: true });
      }
    },
  );
});

// ─── Test 3: import-check — src/cli.ts must not import FakeAdapter ───────────

describe("doctor-real-adapter / Test 3: src/cli.ts does not import fake-adapter", () => {
  test(
    "src/cli.ts source does not import createFakeAdapter or FakeAdapter",
    () => {
      const cliSrc = path.join(
        import.meta.dir,
        "../../src/cli.ts",
      );
      const content = readFileSync(cliSrc, "utf8");

      expect(content).not.toContain("createFakeAdapter");
      expect(content).not.toContain("FakeAdapter");
    },
  );
});
