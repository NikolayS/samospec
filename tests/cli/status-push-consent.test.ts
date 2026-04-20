// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §8 — `samospec status` surfaces `push_consent` per remote URL.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import { runStatus, type StatusAdapterBinding } from "../../src/cli/status.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-status-push-"));
  spawnSync("git", ["init", "-q"], { cwd: tmp });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tmp });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: tmp });
  spawnSync(
    "git",
    ["remote", "add", "origin", "git@example.invalid:me/x.git"],
    {
      cwd: tmp,
    },
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seedState(slug: string): void {
  const slugDir = path.join(tmp, ".samo", "spec", slug);
  mkdirSync(slugDir, { recursive: true });
  const state: State = {
    slug,
    phase: "review_loop",
    round_index: 1,
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
    updated_at: "2026-04-19T12:00:00Z",
  };
  writeState(path.join(slugDir, "state.json"), state);
}

function bindings(): readonly StatusAdapterBinding[] {
  return [
    { role: "lead", adapter: createFakeAdapter({}) },
    { role: "reviewer_a", adapter: createFakeAdapter({}) },
    { role: "reviewer_b", adapter: createFakeAdapter({}) },
  ];
}

describe("status — push_consent surfacing (SPEC §8)", () => {
  test("shows 'push consent: refused' when the repo's remote URL is refused", async () => {
    seedState("refunds");
    writeFileSync(
      path.join(tmp, ".samo", "config.json"),
      JSON.stringify(
        {
          schema_version: 1,
          git: {
            push_consent: {
              "git@example.invalid:me/x.git": false,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const res = await runStatus({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T12:00:00Z",
      adapters: bindings(),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("push consent");
    expect(res.stdout).toContain("origin → refused");
  });

  test("shows 'granted' when persisted consent is true", async () => {
    seedState("refunds");
    writeFileSync(
      path.join(tmp, ".samo", "config.json"),
      JSON.stringify(
        {
          schema_version: 1,
          git: {
            push_consent: {
              "git@example.invalid:me/x.git": true,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const res = await runStatus({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T12:00:00Z",
      adapters: bindings(),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("push consent");
    expect(res.stdout).toContain("origin → granted");
  });

  test("shows 'not yet decided' when no persisted choice exists for this remote", async () => {
    seedState("refunds");
    writeFileSync(
      path.join(tmp, ".samo", "config.json"),
      JSON.stringify({ schema_version: 1 }, null, 2),
      "utf8",
    );
    const res = await runStatus({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T12:00:00Z",
      adapters: bindings(),
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("push consent");
    expect(res.stdout).toContain("origin → not yet decided");
  });
});
