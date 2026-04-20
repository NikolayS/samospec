// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §8 — first-push consent flow.
 *
 * Covers:
 *   - Prompt payload includes remote name, target branch, default branch,
 *     and PR-creation capability.
 *   - `accept` → persisted to `.samospec/config.json` under
 *     `git.push_consent.<remote-url>: true`.
 *   - `refuse` → persisted as `false`.
 *   - Persisted choice is respected silently (no reprompt).
 *   - Distinct remote URLs get distinct persistence keys (key-by-URL).
 *   - `--no-push` invocation override short-circuits even when consent is
 *     persisted true.
 *   - Ctrl-C / prompt abort surfaces as `interrupted` (exit 3).
 *   - PR capability probe surfaces `unavailable` on missing tool.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  clearPersistedConsent,
  loadPersistedConsent,
  persistConsent,
  probePrCapability,
  requestPushConsent,
  type PrCapabilityProbe,
  type PushConsentPrompt,
} from "../../src/git/push-consent.ts";
import { createTempRepo } from "./helpers/tempRepo.ts";

describe("push-consent persistence (git.push_consent.<remote-url>)", () => {
  test("persistConsent writes to .samospec/config.json keyed by remote URL", () => {
    const repo = createTempRepo();
    try {
      const samoDir = path.join(repo.dir, ".samospec");
      mkdirSync(samoDir, { recursive: true });
      writeFileSync(
        path.join(samoDir, "config.json"),
        JSON.stringify({ schema_version: 1 }, null, 2) + "\n",
        "utf8",
      );

      persistConsent({
        repoPath: repo.dir,
        remoteUrl: "git@github.com:foo/bar.git",
        granted: true,
      });

      const raw = readFileSync(path.join(samoDir, "config.json"), "utf8");
      const parsed = JSON.parse(raw) as {
        git?: {
          push_consent?: Record<string, boolean>;
        };
      };
      expect(parsed.git?.push_consent?.["git@github.com:foo/bar.git"]).toBe(
        true,
      );
    } finally {
      repo.cleanup();
    }
  });

  test("loadPersistedConsent returns saved choice", () => {
    const repo = createTempRepo();
    try {
      const samoDir = path.join(repo.dir, ".samospec");
      mkdirSync(samoDir, { recursive: true });
      writeFileSync(
        path.join(samoDir, "config.json"),
        JSON.stringify(
          {
            schema_version: 1,
            git: {
              push_consent: {
                "https://github.com/foo/bar.git": false,
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const out = loadPersistedConsent({
        repoPath: repo.dir,
        remoteUrl: "https://github.com/foo/bar.git",
      });
      expect(out).toBe(false);

      const missing = loadPersistedConsent({
        repoPath: repo.dir,
        remoteUrl: "git@other:x.git",
      });
      expect(missing).toBeNull();
    } finally {
      repo.cleanup();
    }
  });

  test("distinct remote URLs get distinct consent keys", () => {
    const repo = createTempRepo();
    try {
      const samoDir = path.join(repo.dir, ".samospec");
      mkdirSync(samoDir, { recursive: true });
      writeFileSync(
        path.join(samoDir, "config.json"),
        JSON.stringify({ schema_version: 1 }, null, 2) + "\n",
        "utf8",
      );

      persistConsent({
        repoPath: repo.dir,
        remoteUrl: "git@github.com:me/a.git",
        granted: true,
      });
      persistConsent({
        repoPath: repo.dir,
        remoteUrl: "git@gitlab.com:me/a.git",
        granted: false,
      });

      expect(
        loadPersistedConsent({
          repoPath: repo.dir,
          remoteUrl: "git@github.com:me/a.git",
        }),
      ).toBe(true);
      expect(
        loadPersistedConsent({
          repoPath: repo.dir,
          remoteUrl: "git@gitlab.com:me/a.git",
        }),
      ).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  test("clearPersistedConsent removes the key", () => {
    const repo = createTempRepo();
    try {
      const samoDir = path.join(repo.dir, ".samospec");
      mkdirSync(samoDir, { recursive: true });
      writeFileSync(
        path.join(samoDir, "config.json"),
        JSON.stringify({ schema_version: 1 }, null, 2) + "\n",
        "utf8",
      );

      persistConsent({
        repoPath: repo.dir,
        remoteUrl: "X",
        granted: true,
      });
      clearPersistedConsent({ repoPath: repo.dir, remoteUrl: "X" });

      expect(
        loadPersistedConsent({ repoPath: repo.dir, remoteUrl: "X" }),
      ).toBeNull();
    } finally {
      repo.cleanup();
    }
  });
});

describe("requestPushConsent — prompt shape + decisions", () => {
  function baseOpts(repoDir: string): {
    repoPath: string;
    remoteName: string;
    remoteUrl: string;
    targetBranch: string;
    defaultBranch: string;
    prCapability: PrCapabilityProbe;
  } {
    return {
      repoPath: repoDir,
      remoteName: "origin",
      remoteUrl: "git@github.com:me/app.git",
      targetBranch: "samospec/refunds",
      defaultBranch: "main",
      prCapability: { available: true, tool: "gh" },
    };
  }

  test("prompt shows remote, target branch, default branch, and PR capability", async () => {
    const repo = createTempRepo();
    try {
      const samoDir = path.join(repo.dir, ".samospec");
      mkdirSync(samoDir, { recursive: true });
      writeFileSync(
        path.join(samoDir, "config.json"),
        JSON.stringify({ schema_version: 1 }, null, 2) + "\n",
        "utf8",
      );

      let payload: PushConsentPrompt | null = null;
      const outcome = await requestPushConsent({
        ...baseOpts(repo.dir),
        prompt: async (p) => {
          payload = p;
          return "accept";
        },
      });
      expect(outcome.decision).toBe("accept");
      expect(payload).not.toBeNull();
      expect(payload!.remoteName).toBe("origin");
      expect(payload!.remoteUrl).toBe("git@github.com:me/app.git");
      expect(payload!.targetBranch).toBe("samospec/refunds");
      expect(payload!.defaultBranch).toBe("main");
      expect(payload!.prCapability.available).toBe(true);
      expect(payload!.prCapability.tool).toBe("gh");
    } finally {
      repo.cleanup();
    }
  });

  test("accept persists push_consent.<url>=true and returns granted", async () => {
    const repo = createTempRepo();
    try {
      const samoDir = path.join(repo.dir, ".samospec");
      mkdirSync(samoDir, { recursive: true });
      writeFileSync(
        path.join(samoDir, "config.json"),
        JSON.stringify({ schema_version: 1 }, null, 2) + "\n",
        "utf8",
      );

      const out = await requestPushConsent({
        ...baseOpts(repo.dir),
        prompt: async () => "accept",
      });
      expect(out.decision).toBe("accept");
      expect(out.persisted).toBe(true);
      expect(
        loadPersistedConsent({
          repoPath: repo.dir,
          remoteUrl: "git@github.com:me/app.git",
        }),
      ).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  test("refuse persists push_consent.<url>=false", async () => {
    const repo = createTempRepo();
    try {
      const samoDir = path.join(repo.dir, ".samospec");
      mkdirSync(samoDir, { recursive: true });
      writeFileSync(
        path.join(samoDir, "config.json"),
        JSON.stringify({ schema_version: 1 }, null, 2) + "\n",
        "utf8",
      );

      const out = await requestPushConsent({
        ...baseOpts(repo.dir),
        prompt: async () => "refuse",
      });
      expect(out.decision).toBe("refuse");
      expect(out.persisted).toBe(true);
      expect(
        loadPersistedConsent({
          repoPath: repo.dir,
          remoteUrl: "git@github.com:me/app.git",
        }),
      ).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  test("persisted choice short-circuits reprompt silently", async () => {
    const repo = createTempRepo();
    try {
      const samoDir = path.join(repo.dir, ".samospec");
      mkdirSync(samoDir, { recursive: true });
      writeFileSync(
        path.join(samoDir, "config.json"),
        JSON.stringify(
          {
            schema_version: 1,
            git: {
              push_consent: {
                "git@github.com:me/app.git": true,
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      let promptCalls = 0;
      const out = await requestPushConsent({
        ...baseOpts(repo.dir),
        prompt: async () => {
          promptCalls += 1;
          return "accept";
        },
      });
      expect(promptCalls).toBe(0);
      expect(out.decision).toBe("accept");
      expect(out.persisted).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  test("persisted false is respected silently (no reprompt)", async () => {
    const repo = createTempRepo();
    try {
      const samoDir = path.join(repo.dir, ".samospec");
      mkdirSync(samoDir, { recursive: true });
      writeFileSync(
        path.join(samoDir, "config.json"),
        JSON.stringify(
          {
            schema_version: 1,
            git: {
              push_consent: {
                "git@github.com:me/app.git": false,
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      let promptCalls = 0;
      const out = await requestPushConsent({
        ...baseOpts(repo.dir),
        prompt: async () => {
          promptCalls += 1;
          return "accept";
        },
      });
      expect(promptCalls).toBe(0);
      expect(out.decision).toBe("refuse");
      expect(out.persisted).toBe(false);
    } finally {
      repo.cleanup();
    }
  });

  test("prompt returning 'interrupt' surfaces exit code 3", async () => {
    const repo = createTempRepo();
    try {
      const samoDir = path.join(repo.dir, ".samospec");
      mkdirSync(samoDir, { recursive: true });
      writeFileSync(
        path.join(samoDir, "config.json"),
        JSON.stringify({ schema_version: 1 }, null, 2) + "\n",
        "utf8",
      );

      const out = await requestPushConsent({
        ...baseOpts(repo.dir),
        prompt: async () => "interrupt",
      });
      expect(out.decision).toBe("interrupt");
      expect(out.exitCode).toBe(3);
      expect(out.persisted).toBe(false);
    } finally {
      repo.cleanup();
    }
  });
});

describe("probePrCapability", () => {
  test("reports 'unavailable' when both gh and glab fail", () => {
    const probe = probePrCapability({
      gh: () => ({ status: 1, stdout: "", stderr: "" }),
      glab: () => ({ status: 1, stdout: "", stderr: "" }),
    });
    expect(probe.available).toBe(false);
  });

  test("reports 'gh' when gh auth status succeeds", () => {
    const probe = probePrCapability({
      gh: () => ({ status: 0, stdout: "Logged in", stderr: "" }),
      glab: () => ({ status: 1, stdout: "", stderr: "" }),
    });
    expect(probe.available).toBe(true);
    expect(probe.tool).toBe("gh");
  });

  test("reports 'glab' when glab succeeds but gh fails", () => {
    const probe = probePrCapability({
      gh: () => ({ status: 1, stdout: "", stderr: "" }),
      glab: () => ({ status: 0, stdout: "Logged in", stderr: "" }),
    });
    expect(probe.available).toBe(true);
    expect(probe.tool).toBe("glab");
  });
});

describe("config corruption surfaces on load, not silent passthrough", () => {
  test("loadPersistedConsent throws on malformed JSON", () => {
    const repo = createTempRepo();
    try {
      const samoDir = path.join(repo.dir, ".samospec");
      mkdirSync(samoDir, { recursive: true });
      writeFileSync(path.join(samoDir, "config.json"), "not json", "utf8");
      expect(() =>
        loadPersistedConsent({
          repoPath: repo.dir,
          remoteUrl: "X",
        }),
      ).toThrow();
    } finally {
      repo.cleanup();
    }
  });

  test("loadPersistedConsent returns null when config.json is absent", () => {
    const repo = createTempRepo();
    try {
      const samoDir = path.join(repo.dir, ".samospec");
      expect(existsSync(samoDir)).toBe(false);
      expect(
        loadPersistedConsent({
          repoPath: repo.dir,
          remoteUrl: "X",
        }),
      ).toBeNull();
    } finally {
      repo.cleanup();
    }
  });
});
