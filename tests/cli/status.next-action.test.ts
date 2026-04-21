// Copyright 2026 Nikolay Samokhvalov.

/**
 * RED integration test for #96: `samospec status` must consult
 * `state.json.exit.reason` and print the canonical next-action string
 * shared with `iterate` stdout and `TLDR.md`.
 *
 * Converged state (exit.reason = "ready", exit.code = 0) must yield
 * `- next: samospec publish <slug>`.
 *
 * Previously status printed "run `samospec iterate` to start the review
 * loop" regardless of exit state.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import { runStatus } from "../../src/cli/status.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-status-next-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedConverged(slug: string): void {
  const slugDir = path.join(tmp, ".samo", "spec", slug);
  mkdirSync(slugDir, { recursive: true });
  const state: State = {
    slug,
    phase: "review_loop",
    round_index: 3,
    version: "0.4.0",
    persona: { skill: slug, accepted: true },
    push_consent: null,
    calibration: null,
    remote_stale: false,
    coupled_fallback: false,
    head_sha: null,
    round_state: "committed",
    exit: { code: 0, reason: "ready", round_index: 3 },
    created_at: "2026-04-19T12:00:00Z",
    updated_at: "2026-04-19T12:10:00Z",
  };
  writeState(path.join(slugDir, "state.json"), state);
  writeFileSync(path.join(slugDir, "SPEC.md"), "# SPEC\n", "utf8");
}

function seedPreIterate(slug: string): void {
  const slugDir = path.join(tmp, ".samo", "spec", slug);
  mkdirSync(slugDir, { recursive: true });
  const state: State = {
    slug,
    phase: "draft",
    round_index: 0,
    version: "0.1.0",
    persona: { skill: slug, accepted: true },
    push_consent: null,
    calibration: null,
    remote_stale: false,
    coupled_fallback: false,
    head_sha: null,
    round_state: "committed",
    exit: null,
    created_at: "2026-04-19T12:00:00Z",
    updated_at: "2026-04-19T12:00:00Z",
  };
  writeState(path.join(slugDir, "state.json"), state);
  writeFileSync(path.join(slugDir, "SPEC.md"), "# SPEC\n", "utf8");
}

describe("cli/status — next action is unified (#96)", () => {
  test("converged (exit.reason=ready) -> next: samospec publish <slug>", async () => {
    const slug = "refunds";
    seedConverged(slug);
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
    expect(res.stdout).toContain(`next: samospec publish ${slug}`);
    // The old ad-hoc strings must not appear.
    expect(res.stdout).not.toContain("start the review loop");
    expect(res.stdout).not.toContain("continue reviewing");
  });

  test("pre-iterate -> next: samospec iterate <slug>", async () => {
    const slug = "refunds";
    seedPreIterate(slug);
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
    expect(res.stdout).toContain(`next: samospec iterate ${slug}`);
  });
});
