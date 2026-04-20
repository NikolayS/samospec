// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import {
  buildMinimalEnv,
  CLAUDE_NON_INTERACTIVE_FLAGS,
  CODEX_NON_INTERACTIVE_FLAGS,
  verifyNonInteractiveSpawn,
} from "../../src/adapter/spawn.ts";

describe("buildMinimalEnv (SPEC §7 minimal-env spawn)", () => {
  test("passes through HOME, PATH, TMPDIR when present on host", () => {
    const env = buildMinimalEnv({
      host: {
        HOME: "/home/u",
        PATH: "/usr/bin",
        TMPDIR: "/tmp",
        SECRET: "s3cr3t",
      },
      extraAllowedKeys: [],
    });
    expect(env).toEqual({
      HOME: "/home/u",
      PATH: "/usr/bin",
      TMPDIR: "/tmp",
    });
  });

  test("omits keys missing on the host", () => {
    const env = buildMinimalEnv({
      host: { HOME: "/home/u" },
      extraAllowedKeys: [],
    });
    expect(Object.keys(env).sort()).toEqual(["HOME"]);
  });

  test("includes extraAllowedKeys when they exist on host", () => {
    const env = buildMinimalEnv({
      host: {
        HOME: "/h",
        ANTHROPIC_API_KEY: "sk-...",
        UNRELATED: "nope",
      },
      extraAllowedKeys: ["ANTHROPIC_API_KEY"],
    });
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-...");
    expect(env["UNRELATED"]).toBeUndefined();
  });

  test("hard-coded deny: never forwards raw SECRET/OPENAI keys unless explicitly allowed", () => {
    const env = buildMinimalEnv({
      host: {
        HOME: "/h",
        OPENAI_API_KEY: "sk-leaked",
      },
      extraAllowedKeys: [],
    });
    expect(env["OPENAI_API_KEY"]).toBeUndefined();
  });

  test("forwards USER and LOGNAME for macOS Keychain OAuth (#50)", () => {
    const env = buildMinimalEnv({
      host: {
        HOME: "/home/nik",
        PATH: "/usr/bin",
        TMPDIR: "/tmp",
        USER: "nik",
        LOGNAME: "nik",
        SECRET: "s3cr3t",
      },
      extraAllowedKeys: [],
    });
    expect(env["USER"]).toBe("nik");
    expect(env["LOGNAME"]).toBe("nik");
    expect(env["SECRET"]).toBeUndefined();
  });
});

describe("non-interactive flag documentation (SPEC §7)", () => {
  test("Claude flags are --print and --dangerously-skip-permissions", () => {
    // Version-specific equivalents — doctor verifies at runtime (#4).
    expect(CLAUDE_NON_INTERACTIVE_FLAGS).toContain("--print");
    expect(CLAUDE_NON_INTERACTIVE_FLAGS).toContain(
      "--dangerously-skip-permissions",
    );
  });

  test("Codex flags include a non-interactive equivalent", () => {
    // Current Codex CLI: `codex exec` is the non-interactive mode.
    // Document the flag set explicitly.
    expect(CODEX_NON_INTERACTIVE_FLAGS.length).toBeGreaterThan(0);
  });
});

describe("verifyNonInteractiveSpawn (doctor helper)", () => {
  test("returns ok=true when a tiny command runs without a TTY", async () => {
    const r = await verifyNonInteractiveSpawn({
      cmd: ["bun", "--version"],
      timeoutMs: 5000,
    });
    expect(r.ok).toBe(true);
  });

  test("returns ok=false on timeout", async () => {
    // A shell that reads stdin until EOF and we don't send any.
    // Bun.spawn with stdin "pipe" and no write closes after we close.
    // We pass a sleeping command instead.
    const r = await verifyNonInteractiveSpawn({
      cmd: ["bun", "-e", "await new Promise((r) => setTimeout(r, 10_000));"],
      timeoutMs: 150,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("timeout");
    }
  });
});
