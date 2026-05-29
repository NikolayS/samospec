// Copyright 2026 Nikolay Samokhvalov.

// Config-driven adapter construction (samospec robustness pass).
//
// The headline regression these tests lock down: editing
// `adapters.<role>.model_id` in `.samo/config.json` must actually change
// the `--model` pin the adapter spawns with. Before FIX 1 the config was
// ignored and the hardcoded pinned default was always used.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildClaudeResolver,
  buildLeadAdapter,
  buildReviewLoopAdaptersFromConfig,
  readAdaptersConfig,
  resolveChain,
} from "../../src/adapter/from-config.ts";
import type { ClaudeAdapter } from "../../src/adapter/claude.ts";
import type { CodexAdapter } from "../../src/adapter/codex.ts";
import type { SpawnCliInput, SpawnCliResult } from "../../src/adapter/spawn.ts";
import type { AskInput } from "../../src/adapter/types.ts";

// ---------- spawn spy ----------

interface SpawnSpy {
  readonly spawn: (input: SpawnCliInput) => Promise<SpawnCliResult>;
  readonly calls: { cmd: readonly string[]; stdinLen: number }[];
}

function makeSpy(stdout: string): SpawnSpy {
  const calls: { cmd: readonly string[]; stdinLen: number }[] = [];
  const spawn = (input: SpawnCliInput): Promise<SpawnCliResult> => {
    calls.push({ cmd: [...input.cmd], stdinLen: input.stdin.length });
    return Promise.resolve({ ok: true, exitCode: 0, stdout, stderr: "" });
  };
  return { spawn, calls };
}

function fakeClaudeHost(): Record<string, string | undefined> {
  // A directory with no `claude` binary is fine: work-call spawns are
  // intercepted by the injected spy, which never touches the binary.
  const dir = mkdtempSync(join(tmpdir(), "samospec-fc-host-"));
  writeFileSync(join(dir, "claude"), "#!/usr/bin/env bash\necho 2.1.156\n");
  writeFileSync(join(dir, "codex"), "#!/usr/bin/env bash\necho 1.0.0\n");
  return { PATH: dir, HOME: "/tmp", ANTHROPIC_API_KEY: "sk-ant-test" };
}

function sampleAsk(): AskInput {
  return {
    prompt: "ping",
    context: "",
    opts: { effort: "max", timeout: 120_000 },
  };
}

function writeConfig(cwd: string, config: unknown): void {
  mkdirSync(join(cwd, ".samo"), { recursive: true });
  writeFileSync(
    join(cwd, ".samo", "config.json"),
    JSON.stringify(config, null, 2),
  );
}

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "samospec-fc-repo-"));
}

// ---------- readAdaptersConfig ----------

describe("readAdaptersConfig", () => {
  test("returns {} when no config file exists", () => {
    expect(readAdaptersConfig(tmpRepo())).toEqual({});
  });

  test("returns {} on malformed JSON", () => {
    const cwd = tmpRepo();
    mkdirSync(join(cwd, ".samo"), { recursive: true });
    writeFileSync(join(cwd, ".samo", "config.json"), "{ not json");
    expect(readAdaptersConfig(cwd)).toEqual({});
  });

  test("extracts model_id + fallback_chain per role", () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: {
        lead: {
          model_id: "claude-opus-4-8",
          fallback_chain: ["claude-opus-4-8", "terminal"],
        },
        reviewer_a: {
          model_id: "gpt-5.5",
          fallback_chain: ["gpt-5.5", "gpt-5.4"],
        },
        reviewer_b: { model_id: "claude-opus-4-8" },
      },
    });
    expect(readAdaptersConfig(cwd)).toEqual({
      lead: {
        model_id: "claude-opus-4-8",
        fallback_chain: ["claude-opus-4-8", "terminal"],
      },
      reviewer_a: {
        model_id: "gpt-5.5",
        fallback_chain: ["gpt-5.5", "gpt-5.4"],
      },
      reviewer_b: { model_id: "claude-opus-4-8" },
    });
  });
});

// ---------- resolveChain ----------

describe("resolveChain", () => {
  test("undefined cfg -> undefined (keep adapter default)", () => {
    expect(resolveChain(undefined)).toBeUndefined();
  });

  test("pins model_id first, de-dupes, strips sentinels", () => {
    expect(
      resolveChain({
        model_id: "claude-opus-4-8",
        fallback_chain: [
          "claude-opus-4-8",
          "claude-opus-4-7",
          "terminal",
          "__account_default__",
        ],
      }),
    ).toEqual(["claude-opus-4-8", "claude-opus-4-7"]);
  });

  test("chain of only sentinels -> undefined", () => {
    expect(resolveChain({ fallback_chain: ["terminal"] })).toBeUndefined();
  });
});

// ---------- END-TO-END: config model_id actually reaches --model ----------

describe("config-pinned lead model reaches the spawned --model (FIX 1)", () => {
  test("lead pinned to claude-opus-4-8 spawns --model claude-opus-4-8", async () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: {
        lead: {
          adapter: "claude",
          model_id: "claude-opus-4-8",
          fallback_chain: ["claude-opus-4-8", "claude-opus-4-7", "terminal"],
        },
      },
    });

    const spy = makeSpy('{"answer":"ok","usage":null,"effort_used":"max"}');
    const lead = buildLeadAdapter(cwd) as ClaudeAdapter;
    // Re-spawn through the spy + fake host: clone with injected deps.
    const pinned = new (lead.constructor as typeof ClaudeAdapter)({
      host: fakeClaudeHost(),
      spawn: spy.spawn,
      models: [{ id: "claude-opus-4-8", family: "claude" }],
      defaultModel: lead.currentModelId(),
    });

    // Sanity: the factory resolved the configured pin, not the hardcoded 4-7.
    expect(lead.currentModelId()).toBe("claude-opus-4-8");

    await pinned.ask(sampleAsk());
    const work = spy.calls.find((c) => c.stdinLen > 0);
    expect(work).toBeDefined();
    if (work === undefined) return;
    const idx = work.cmd.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(work.cmd[idx + 1]).toBe("claude-opus-4-8");
    // Negative assertion: the stale hardcoded default never appears.
    expect(work.cmd).not.toContain("claude-opus-4-7");
  });

  test("absent config falls back to the pinned default (claude-opus-4-8)", () => {
    const lead = buildLeadAdapter(tmpRepo()) as ClaudeAdapter;
    expect(lead.currentModelId()).toBe("claude-opus-4-8");
  });

  // Strongest proof: a REAL subprocess. A fake `claude` binary on PATH
  // records its argv to a file. We build the lead adapter purely from
  // config (no injected spawn) and call ask() for real; the recorded
  // argv must carry `--model claude-opus-4-8`. This exercises the full
  // config -> factory -> ClaudeAdapter -> spawnCli -> argv path.
  test("real subprocess: config-pinned lead spawns a real `claude --model claude-opus-4-8`", async () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: {
        lead: {
          adapter: "claude",
          model_id: "claude-opus-4-8",
          fallback_chain: ["claude-opus-4-8", "terminal"],
        },
      },
    });

    // Fake `claude` binary: records its argv, then emits valid ask() JSON.
    const binDir = mkdtempSync(join(tmpdir(), "samospec-fc-bin-"));
    const argvFile = join(binDir, "argv.txt");
    const fake =
      "#!/usr/bin/env bash\n" +
      `printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}\n` +
      // --version probe (detect) returns a version; work call returns JSON.
      'if [ "$1" = "--version" ]; then echo "2.1.156"; exit 0; fi\n' +
      'echo \'{"answer":"ok","usage":null,"effort_used":"max"}\'\n';
    writeFileSync(join(binDir, "claude"), fake, { mode: 0o755 });

    const host = {
      // Include system bin dirs so the fake binary's `#!/usr/bin/env bash`
      // shebang resolves under the adapter's minimal-env spawn.
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: "/tmp",
      ANTHROPIC_API_KEY: "sk-ant-test",
    };
    // Build from config, then point it at the fake binary + host. The
    // model pin still comes entirely from config (defaultModel/models).
    const fromCfg = buildLeadAdapter(cwd) as ClaudeAdapter;
    expect(fromCfg.currentModelId()).toBe("claude-opus-4-8");
    const lead = new (fromCfg.constructor as typeof ClaudeAdapter)({
      host,
      models: [{ id: fromCfg.currentModelId(), family: "claude" }],
      defaultModel: fromCfg.currentModelId(),
    });

    await lead.ask(sampleAsk());

    const recorded = readFileSync(argvFile, "utf8").split("\n");
    const idx = recorded.indexOf("--model");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(recorded[idx + 1]).toBe("claude-opus-4-8");
    expect(recorded).not.toContain("claude-opus-4-7");
  });
});

// ---------- review loop trio is config-driven ----------

describe("buildReviewLoopAdaptersFromConfig (FIX 1)", () => {
  test("lead + reviewer_b resolve the configured Claude pin; reviewer_a the codex pin", () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: {
        lead: {
          model_id: "claude-opus-4-8",
          fallback_chain: ["claude-opus-4-8", "terminal"],
        },
        reviewer_a: {
          model_id: "gpt-5.5",
          fallback_chain: ["gpt-5.5", "gpt-5.4", "terminal"],
        },
        reviewer_b: {
          model_id: "claude-opus-4-8",
          fallback_chain: ["claude-opus-4-8", "terminal"],
        },
      },
    });
    const { lead, reviewerA, reviewerB } =
      buildReviewLoopAdaptersFromConfig(cwd);
    expect((lead as ClaudeAdapter).currentModelId()).toBe("claude-opus-4-8");
    expect((reviewerB as ClaudeAdapter).currentModelId()).toBe(
      "claude-opus-4-8",
    );
    expect((reviewerA as CodexAdapter).currentModelId()).toBe("gpt-5.5");
  });

  test("buildClaudeResolver advances along the configured lead chain", () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: {
        lead: {
          model_id: "claude-opus-4-8",
          fallback_chain: ["claude-opus-4-8", "claude-sonnet-4-6", "terminal"],
        },
      },
    });
    const resolver = buildClaudeResolver(readAdaptersConfig(cwd));
    expect(resolver.getCurrentModel()).toBe("claude-opus-4-8");
    resolver.reportUnavailable("claude-opus-4-8");
    // The configured fallback chain (sentinels stripped) is honored.
    expect(resolver.getCurrentModel()).toBe("claude-sonnet-4-6");
  });

  test("absent config -> pinned defaults (lead 4-8, reviewer_a gpt-5.5)", () => {
    const { lead, reviewerA } = buildReviewLoopAdaptersFromConfig(tmpRepo());
    expect((lead as ClaudeAdapter).currentModelId()).toBe("claude-opus-4-8");
    expect((reviewerA as CodexAdapter).currentModelId()).toBe("gpt-5.5");
  });
});

// ---------- FIX 3: warn when reviewer_b config diverges from lead ----------

describe("buildReviewLoopAdaptersFromConfig — reviewer_b coupling warning (FIX 3)", () => {
  test("warns once when reviewer_b's chain DIFFERS from lead's (SPEC §11 coupling makes it inert)", () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: {
        lead: {
          model_id: "claude-opus-4-8",
          fallback_chain: ["claude-opus-4-8", "terminal"],
        },
        reviewer_b: {
          // Deliberately DIFFERENT from lead — this is silently ignored
          // because reviewer_b shares the lead's resolver (SPEC §11).
          model_id: "claude-sonnet-4-6",
          fallback_chain: ["claude-sonnet-4-6", "terminal"],
        },
      },
    });
    const warnings: string[] = [];
    buildReviewLoopAdaptersFromConfig(cwd, {
      warn: (line) => warnings.push(line),
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("reviewer_b");
    expect(warnings[0]).toContain("§11");
    expect(warnings[0]?.toLowerCase()).toContain("ignored");
  });

  test("silent when reviewer_b matches lead", () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: {
        lead: {
          model_id: "claude-opus-4-8",
          fallback_chain: ["claude-opus-4-8", "terminal"],
        },
        reviewer_b: {
          model_id: "claude-opus-4-8",
          fallback_chain: ["claude-opus-4-8", "terminal"],
        },
      },
    });
    const warnings: string[] = [];
    buildReviewLoopAdaptersFromConfig(cwd, {
      warn: (line) => warnings.push(line),
    });
    expect(warnings).toEqual([]);
  });

  test("silent when reviewer_b config is absent", () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: {
        lead: {
          model_id: "claude-opus-4-8",
          fallback_chain: ["claude-opus-4-8", "terminal"],
        },
      },
    });
    const warnings: string[] = [];
    buildReviewLoopAdaptersFromConfig(cwd, {
      warn: (line) => warnings.push(line),
    });
    expect(warnings).toEqual([]);
  });
});
