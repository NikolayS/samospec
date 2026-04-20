// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type { Adapter } from "../../src/adapter/types.ts";
import { runStatus } from "../../src/cli/status.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-status-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedMinimal(slug: string, round: number = 1, override: Partial<State> = {}): void {
  const slugDir = path.join(tmp, ".samospec", "spec", slug);
  mkdirSync(slugDir, { recursive: true });
  const state: State = {
    slug,
    phase: "review_loop",
    round_index: round,
    version: "0.2.0",
    persona: { skill: "refunds", accepted: true },
    push_consent: null,
    calibration: null,
    remote_stale: false,
    coupled_fallback: false,
    head_sha: null,
    round_state: "committed",
    exit: null,
    created_at: "2026-04-19T12:00:00Z",
    updated_at: "2026-04-19T12:10:00Z",
    ...override,
  };
  writeState(path.join(slugDir, "state.json"), state);
  writeFileSync(path.join(slugDir, "SPEC.md"), "# SPEC\n", "utf8");
}

describe("cli/status — preconditions", () => {
  test("exits 1 when state.json is missing", async () => {
    const res = await runStatus({
      cwd: tmp,
      slug: "no-such-slug",
      now: "2026-04-19T12:10:00Z",
      adapters: [
        { role: "lead", adapter: createFakeAdapter({}) },
      ],
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("samospec new no-such-slug");
  });
});

describe("cli/status — healthy run", () => {
  test("prints phase, round, version, next action", async () => {
    const slug = "refunds";
    seedMinimal(slug, 2);
    const res = await runStatus({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:10:00Z",
      adapters: [
        { role: "lead", adapter: createFakeAdapter({}) },
        { role: "reviewer_a", adapter: createFakeAdapter({}) },
        { role: "reviewer_b", adapter: createFakeAdapter({}) },
      ],
      sessionStartedAtMs: 0,
      nowMs: 0,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("phase: review_loop");
    expect(res.stdout).toContain("round: 2 (committed)");
    expect(res.stdout).toContain("version: 0.2.0");
    expect(res.stdout).toContain("next:");
    expect(res.stdout).toContain("running cost");
    expect(res.stdout).toContain("wall-clock");
    expect(res.stdout).toContain("worst-case one more round");
  });
});

describe("cli/status — subscription-auth flag", () => {
  test("shows `unknown (subscription auth)` per adapter in the cost block", async () => {
    const slug = "refunds";
    seedMinimal(slug);

    const subAdapter: Adapter = {
      ...createFakeAdapter({
        auth: {
          authenticated: true,
          subscription_auth: true,
        },
      }),
    };
    const res = await runStatus({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:10:00Z",
      adapters: [
        { role: "lead", adapter: subAdapter },
        { role: "reviewer_a", adapter: createFakeAdapter({}) },
        { role: "reviewer_b", adapter: subAdapter },
      ],
      sessionStartedAtMs: 0,
      nowMs: 0,
    });
    expect(res.stdout).toContain("lead (fake): unknown (subscription auth)");
    expect(res.stdout).toContain(
      "subscription auth: enabled — token budgets disabled",
    );
  });
});

describe("cli/status — degraded resolution (SPEC §11)", () => {
  test("prints 'running with degraded model resolution' line", async () => {
    const slug = "refunds";
    seedMinimal(slug, 1, { coupled_fallback: true });
    const res = await runStatus({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:10:00Z",
      adapters: [
        { role: "lead", adapter: createFakeAdapter({}) },
        { role: "reviewer_a", adapter: createFakeAdapter({}) },
        { role: "reviewer_b", adapter: createFakeAdapter({}) },
      ],
      resolutions: {
        lead: { adapter: "claude", model_id: "claude-sonnet-4-6" },
        reviewer_a: { adapter: "codex", model_id: "gpt-5.1-codex-max" },
        reviewer_b: { adapter: "claude", model_id: "claude-sonnet-4-6" },
        coupled_fallback: true,
      },
      sessionStartedAtMs: 0,
      nowMs: 0,
    });
    expect(res.stdout).toContain("running with degraded model resolution");
    expect(res.stdout).toContain("lead fell back to claude-sonnet-4-6");
    expect(res.stdout).toContain("coupled_fallback");
  });
});

describe("cli/status — wall-clock overrun warning", () => {
  test("prints warning when remaining < worst-case", async () => {
    const slug = "refunds";
    seedMinimal(slug, 1);
    const res = await runStatus({
      cwd: tmp,
      slug,
      now: "2026-04-19T12:10:00Z",
      adapters: [
        { role: "lead", adapter: createFakeAdapter({}) },
        { role: "reviewer_a", adapter: createFakeAdapter({}) },
        { role: "reviewer_b", adapter: createFakeAdapter({}) },
      ],
      sessionStartedAtMs: 0,
      nowMs: 60_000,
      maxWallClockMs: 120_000, // 2 min
    });
    expect(res.stdout).toContain("warning");
    expect(res.stdout).toContain("next `samospec iterate` will halt");
  });
});
