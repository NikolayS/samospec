// Copyright 2026 Nikolay Samokhvalov.

// RED tests for #60: samospec new / resume must not contain stale
// "Sprint 3" or "--no-push default active" scaffolding text.
// We test both via direct source inspection (most reliable, catches the
// literal strings before they reach any output path) and via a
// minimal runNew invocation that exercises the notice() path.

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { runNew } from "../../src/cli/new.ts";
import type { RunNewInput, ChoiceResolvers } from "../../src/cli/new.ts";
import type { Adapter } from "../../src/adapter/types.ts";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Read CLI source files for stale-text checks.
const NEW_SRC = readFileSync(
  new URL("../../src/cli/new.ts", import.meta.url).pathname,
  "utf8",
);
const RESUME_SRC = readFileSync(
  new URL("../../src/cli/resume.ts", import.meta.url).pathname,
  "utf8",
);

// Minimal fake adapter that returns fast without spawning real CLIs.
function makeFakeAdapter(): Adapter {
  return {
    vendor: "claude",
    detect: async () => ({ installed: true, version: "1.0.0", path: "/usr/bin/claude" }),
    auth_status: async () => ({ authenticated: true, subscription_auth: false }),
    supports_structured_output: () => true,
    supports_effort: () => true,
    models: async () => [{ id: "claude-opus-4-7", family: "claude" }],
    ask: async () => ({
      answer: 'Veteran "CLI systems engineer" expert',
      usage: null,
      effort_used: "max",
    }),
    critique: async () => ({
      findings: [],
      summary: "Looks good.",
      suggested_next_version: "v0.2",
      usage: null,
      effort_used: "max",
    }),
    revise: async () => ({
      spec:
        "# Test Spec — SPEC v0.1\n\n## Goal\n\nTest.\n\n## User Stories\n\n1. Story 1\n\n## Architecture\n\nTBD\n",
      ready: false,
      rationale: "Initial draft.",
      usage: null,
      effort_used: "max",
    }),
  };
}

const FAKE_RESOLVERS: ChoiceResolvers = {
  persona: async (p) => ({ kind: "accept" }),
  question: async (q) => ({
    id: q.id,
    choice: "decide for me",
    custom: undefined,
  }),
};

async function runNewInTmpDir(tmpDir: string): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  mkdirSync(join(tmpDir, ".samo"), { recursive: true });

  const input: RunNewInput = {
    cwd: tmpDir,
    slug: "test-slug",
    idea: "A simple test idea for sprint text removal",
    explain: false,
    resolvers: FAKE_RESOLVERS,
    now: "2026-04-19T10:00:00Z",
  };

  return runNew(input, makeFakeAdapter());
}

describe("samospec new/resume source — no stale sprint text (#60)", () => {
  // Source-level checks: the literal stale strings must not appear in
  // the user-visible notice paths of new.ts or resume.ts.

  test("new.ts source does not contain 'review loop lands in Sprint'", () => {
    expect(NEW_SRC).not.toContain("review loop lands in Sprint");
  });

  test("new.ts source does not contain '--no-push default active'", () => {
    expect(NEW_SRC).not.toContain("--no-push default active");
  });

  test("new.ts source does not contain 'push consent gate ships in Sprint'", () => {
    expect(NEW_SRC).not.toContain("push consent gate ships in Sprint");
  });

  test("resume.ts source does not contain 'ready for review loop (Sprint 3)'", () => {
    expect(RESUME_SRC).not.toContain("ready for review loop (Sprint 3)");
  });

  test("new.ts source does not contain 'Sprint 3' in any notice string", () => {
    // Allow "Sprint 3" in comments only (the comment at the top mentions Sprint 3
    // for scope context). Check the user-visible string literals specifically.
    // The stale text appears in notice() calls — check for the runtime strings.
    expect(NEW_SRC).not.toContain(
      "review loop lands in Sprint 3",
    );
    expect(NEW_SRC).not.toContain(
      "--no-push default active; push consent gate ships in Sprint 3",
    );
  });
});

describe("samospec new stdout — next-step hint present (#60)", () => {
  test("stdout contains a valid next-step hint (samospec iterate or resume)", async () => {
    const tmpDir = join(tmpdir(), `samospec-sprint-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const result = await runNewInTmpDir(tmpDir);
    // Should have a next step hint that mentions iterate or resume
    const hasNextStep =
      result.stdout.includes("samospec iterate") ||
      result.stdout.includes("samospec resume");
    expect(hasNextStep).toBe(true);
  });
});
