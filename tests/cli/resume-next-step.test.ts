// Copyright 2026 Nikolay Samokhvalov.

/**
 * RED tests for #71: after `samospec resume <slug>`, stdout contains
 * a `next:` hint appropriate for the current phase.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type { Adapter, AskInput, AskOutput } from "../../src/adapter/types.ts";
import { runResume } from "../../src/cli/resume.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-resume-next-step-"));
  initRepo(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function initRepo(cwd: string): void {
  spawnSync("git", ["init", "-q"], { cwd });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd });
  spawnSync("git", ["config", "user.name", "Test"], { cwd });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd });
  spawnSync("git", ["checkout", "-q", "-b", "samospec/my-slug"], { cwd });
  writeFileSync(path.join(cwd, "README.md"), "seed\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd });
}

function seedDraftCommitted(cwd: string, slug: string): void {
  const slugDir = path.join(cwd, ".samo", "spec", slug);
  mkdirSync(slugDir, { recursive: true });

  const state: State = {
    slug,
    phase: "draft",
    round_state: "committed",
    round_index: 0,
    version: "0.1.0",
    created_at: "2026-04-19T00:00:00Z",
    updated_at: "2026-04-19T00:00:00Z",
    persona: { skill: "payments", accepted: true },
    push_consent: null,
    calibration: null,
    coupled_fallback: false,
    remote_stale: false,
    exit: null,
  };
  writeState(path.join(slugDir, "state.json"), state);

  writeFileSync(
    path.join(slugDir, "SPEC.md"),
    "# SPEC\n\ncontent\n",
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "TLDR.md"),
    "# TLDR\n\n- item\n",
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "interview.json"),
    JSON.stringify({
      slug,
      persona: 'Veteran "payments" expert',
      generated_at: "2026-04-19T00:00:00Z",
      questions: [],
      answers: [],
    }),
    "utf8",
  );
}

function seedReviewLoopCommitted(cwd: string, slug: string): void {
  const slugDir = path.join(cwd, ".samo", "spec", slug);
  mkdirSync(slugDir, { recursive: true });

  const state: State = {
    slug,
    phase: "review_loop",
    round_state: "committed",
    round_index: 3,
    version: "0.4.0",
    created_at: "2026-04-19T00:00:00Z",
    updated_at: "2026-04-19T00:00:00Z",
    persona: { skill: "payments", accepted: true },
    push_consent: null,
    calibration: null,
    coupled_fallback: false,
    remote_stale: false,
    exit: null,
  };
  writeState(path.join(slugDir, "state.json"), state);

  writeFileSync(
    path.join(slugDir, "SPEC.md"),
    "# SPEC\n\ncontent\n",
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "TLDR.md"),
    "# TLDR\n\n- item\n",
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "interview.json"),
    JSON.stringify({
      slug,
      persona: 'Veteran "payments" expert',
      generated_at: "2026-04-19T00:00:00Z",
      questions: [],
      answers: [],
    }),
    "utf8",
  );
}

function makeAdapter(): Adapter {
  return createFakeAdapter();
}

const SLUG = "my-slug";
const NOW = "2026-04-19T12:00:00Z";

const resolvers = {
  persona: () => Promise.resolve({ kind: "accept" as const }),
  question: () => Promise.resolve("answer"),
};

describe("resume next-step hints (#71)", () => {
  test("draft/committed -> hint: samospec iterate <slug>", async () => {
    seedDraftCommitted(tmp, SLUG);

    const result = await runResume(
      {
        cwd: tmp,
        slug: SLUG,
        now: NOW,
        resolvers,
      },
      makeAdapter(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`next: samospec iterate ${SLUG}`);
  });

  test("review_loop/committed -> hint: samospec publish <slug>", async () => {
    seedReviewLoopCommitted(tmp, SLUG);

    const result = await runResume(
      {
        cwd: tmp,
        slug: SLUG,
        now: NOW,
        resolvers,
      },
      makeAdapter(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`next: samospec publish ${SLUG}`);
  });
});
