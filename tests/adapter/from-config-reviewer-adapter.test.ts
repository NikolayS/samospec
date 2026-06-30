// Copyright 2026 Nikolay Samokhvalov.

// Per-seat Reviewer A adapter selection (samospec configurable-panel
// pass).
//
// The headline behavior these tests lock down: `adapters.reviewer_a`
// gains an `adapter` vendor selector ("claude" | "codex"). Absent or
// "codex" keeps the historical CodexAdapter (back-compatible); "claude"
// builds a Claude-vendor Reviewer A that (a) reports vendor "claude",
// (b) joins the lead's shared resolver (SPEC §11 coupled fallback), and
// (c) carries the SAME security/ops persona as the codex seat.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildReviewLoopAdaptersFromConfig,
  readAdaptersConfig,
} from "../../src/adapter/from-config.ts";
import { ClaudeAdapter } from "../../src/adapter/claude.ts";
import {
  ClaudeReviewerAAdapter,
  REVIEWER_A_PERSONA_PREFIX,
} from "../../src/adapter/claude-reviewer-a.ts";
import { CodexAdapter } from "../../src/adapter/codex.ts";
import type { SpawnCliInput, SpawnCliResult } from "../../src/adapter/spawn.ts";
import type { CritiqueInput } from "../../src/adapter/types.ts";

// ---------- helpers ----------

function writeConfig(cwd: string, config: unknown): void {
  mkdirSync(join(cwd, ".samo"), { recursive: true });
  writeFileSync(
    join(cwd, ".samo", "config.json"),
    JSON.stringify(config, null, 2),
  );
}

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "samospec-fc-ra-"));
}

function installedHost(): Record<string, string | undefined> {
  // A directory with fake `claude`/`codex` binaries. Work-call spawns are
  // intercepted by the injected spy, so the binaries are never executed.
  const dir = mkdtempSync(join(tmpdir(), "samospec-fc-ra-host-"));
  writeFileSync(join(dir, "claude"), "#!/usr/bin/env bash\necho 2.1.156\n");
  writeFileSync(join(dir, "codex"), "#!/usr/bin/env bash\necho 1.0.0\n");
  return { PATH: dir, HOME: "/tmp", ANTHROPIC_API_KEY: "sk-ant-test" };
}

interface SpawnSpy {
  readonly spawn: (input: SpawnCliInput) => Promise<SpawnCliResult>;
  readonly calls: { cmd: readonly string[]; stdinLen: number; stdin: string }[];
}

function makeSpy(stdout: string): SpawnSpy {
  const calls: { cmd: readonly string[]; stdinLen: number; stdin: string }[] =
    [];
  const spawn = (input: SpawnCliInput): Promise<SpawnCliResult> => {
    calls.push({
      cmd: [...input.cmd],
      stdinLen: input.stdin.length,
      stdin: input.stdin,
    });
    return Promise.resolve({ ok: true, exitCode: 0, stdout, stderr: "" });
  };
  return { spawn, calls };
}

function sampleCritique(): CritiqueInput {
  return {
    spec: "# SPEC\n\nplaceholder",
    guidelines: "be pedantic",
    opts: { effort: "max", timeout: 120_000 },
  };
}

// ---------- persona parity ----------

describe("ClaudeReviewerAAdapter — persona parity (SPEC §7)", () => {
  test("re-exports the verbatim codex security/ops persona prefix", () => {
    expect(REVIEWER_A_PERSONA_PREFIX).toBe(
      "You are a paranoid security/ops engineer reviewing this spec. " +
        "Focus especially on missing-risk, weak-implementation, and " +
        "unnecessary-scope. You may surface findings in other categories " +
        "when warranted, but weight your effort toward these.",
    );
  });

  test("critique() forwards the security/ops persona to the CLI via stdin", async () => {
    const spy = makeSpy(
      '{"findings":[{"category":"missing-risk","text":"x",' +
        '"severity":"major"}],"summary":"s",' +
        '"suggested_next_version":"0.1.1","usage":null,' +
        '"effort_used":"max"}',
    );
    const adapter = new ClaudeReviewerAAdapter({
      host: installedHost(),
      spawn: spy.spawn,
    });

    await adapter.critique(sampleCritique());

    const workCall = spy.calls.find((c) => c.stdinLen > 0);
    expect(workCall).toBeDefined();
    if (workCall === undefined) return;
    expect(workCall.stdin).toContain(
      "You are a paranoid security/ops engineer reviewing this spec.",
    );
    expect(workCall.stdin).toContain("missing-risk");
    expect(workCall.stdin).toContain("unnecessary-scope");
  });
});

// ---------- readAdaptersConfig threads the adapter field ----------

describe("readAdaptersConfig — per-seat adapter field", () => {
  test("extracts adapter alongside model_id / fallback_chain", () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: {
        reviewer_a: {
          adapter: "claude",
          model_id: "claude-opus-4-8",
          fallback_chain: ["claude-opus-4-8", "terminal"],
        },
      },
    });
    expect(readAdaptersConfig(cwd)).toEqual({
      reviewer_a: {
        adapter: "claude",
        model_id: "claude-opus-4-8",
        fallback_chain: ["claude-opus-4-8", "terminal"],
      },
    });
  });

  test("ignores an unrecognized adapter value (keeps the seat default vendor)", () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: { reviewer_a: { adapter: "gemini", model_id: "x" } },
    });
    expect(readAdaptersConfig(cwd)).toEqual({
      reviewer_a: { model_id: "x" },
    });
  });
});

// ---------- review-loop trio honors the reviewer_a vendor ----------

describe("buildReviewLoopAdaptersFromConfig — reviewer_a vendor selection", () => {
  test('adapter: "claude" -> reviewerA is a Claude-vendor adapter', () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: {
        lead: {
          model_id: "claude-opus-4-8",
          fallback_chain: ["claude-opus-4-8", "terminal"],
        },
        reviewer_a: {
          adapter: "claude",
          model_id: "claude-opus-4-8",
          fallback_chain: ["claude-opus-4-8", "terminal"],
        },
      },
    });
    const { reviewerA } = buildReviewLoopAdaptersFromConfig(cwd);
    expect(reviewerA).toBeInstanceOf(ClaudeReviewerAAdapter);
    expect(reviewerA).toBeInstanceOf(ClaudeAdapter);
    expect(reviewerA.vendor).toBe("claude");
    expect(reviewerA).not.toBeInstanceOf(CodexAdapter);
  });

  test('adapter: "claude" reviewerA tracks the lead pin (SPEC §11 coupled resolver)', () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: {
        lead: {
          model_id: "claude-opus-4-8",
          fallback_chain: ["claude-opus-4-8", "claude-sonnet-4-6", "terminal"],
        },
        reviewer_a: { adapter: "claude" },
      },
    });
    const { lead, reviewerA } = buildReviewLoopAdaptersFromConfig(cwd);
    // Lead and a Claude Reviewer A start at the same configured head and
    // read the same pin — they are coupled through the shared resolver.
    expect((lead as ClaudeAdapter).currentModelId()).toBe("claude-opus-4-8");
    expect((reviewerA as ClaudeAdapter).currentModelId()).toBe(
      "claude-opus-4-8",
    );
  });

  test("absent adapter key -> reviewerA is CodexAdapter (default unchanged)", () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: {
        reviewer_a: {
          model_id: "gpt-5.5",
          fallback_chain: ["gpt-5.5", "gpt-5.4", "terminal"],
        },
      },
    });
    const { reviewerA } = buildReviewLoopAdaptersFromConfig(cwd);
    expect(reviewerA).toBeInstanceOf(CodexAdapter);
    expect(reviewerA.vendor).toBe("codex");
    expect((reviewerA as CodexAdapter).currentModelId()).toBe("gpt-5.5");
  });

  test('adapter: "codex" -> reviewerA is CodexAdapter (explicit default)', () => {
    const cwd = tmpRepo();
    writeConfig(cwd, {
      adapters: { reviewer_a: { adapter: "codex", model_id: "gpt-5.4" } },
    });
    const { reviewerA } = buildReviewLoopAdaptersFromConfig(cwd);
    expect(reviewerA).toBeInstanceOf(CodexAdapter);
    expect((reviewerA as CodexAdapter).currentModelId()).toBe("gpt-5.4");
  });

  test("absent config -> reviewerA is CodexAdapter pinned default", () => {
    const { reviewerA } = buildReviewLoopAdaptersFromConfig(tmpRepo());
    expect(reviewerA).toBeInstanceOf(CodexAdapter);
    expect((reviewerA as CodexAdapter).currentModelId()).toBe("gpt-5.5");
  });
});
