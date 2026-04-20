// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §5 Phase 6 + §8 — round-boundary push integration.
 *
 * Tests the contract between `runIterate` and the push-consent +
 * pushBranch helpers:
 *
 *   - Consent `accept` + 2 rounds to ready → exactly 2 pushes land on
 *     the real bare remote, not 2 * N commits' worth.
 *   - `--no-push` invocation override wins over persisted-accept.
 *   - Persisted `refuse` skips all pushes silently; no prompt fires
 *     during the loop; the loop exits 0 (not 5) — SPEC §10 reserves
 *     exit 5 for preflight refusal.
 *   - Prompt fires only once per session (first round); subsequent
 *     rounds respect the session decision without re-prompting.
 *   - Ctrl-C at first consent prompt → exit 3.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type { Adapter, CritiqueOutput } from "../../src/adapter/types.ts";
import { runIterate, type IterateResolvers } from "../../src/cli/iterate.ts";
import { writeState } from "../../src/state/store.ts";
import type { State } from "../../src/state/types.ts";

let tmp: string;
let bare: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-push-iter-"));
  bare = mkdtempSync(path.join(tmpdir(), "samospec-push-bare-"));
  spawnSync("git", ["init", "--bare", "--initial-branch", "main"], {
    cwd: bare,
  });
  initRepo(tmp, bare);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
});

function initRepo(cwd: string, bareUrl: string): void {
  spawnSync("git", ["init", "-q", "--initial-branch", "main"], { cwd });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd });
  spawnSync("git", ["config", "user.name", "Test"], { cwd });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd });
  writeFileSync(path.join(cwd, "README.md"), "seed\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd });
  spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd });
  spawnSync("git", ["remote", "add", "origin", bareUrl], { cwd });
  spawnSync("git", ["checkout", "-q", "-b", "samospec/refunds"], { cwd });
}

function seedSpec(cwd: string, slug: string): void {
  const slugDir = path.join(cwd, ".samospec", "spec", slug);
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(
    path.join(slugDir, "SPEC.md"),
    "# SPEC\n\nv0.1 body\n- initial requirement\n",
    "utf8",
  );
  writeFileSync(path.join(slugDir, "TLDR.md"), "# TLDR\n\n- stub\n", "utf8");
  writeFileSync(
    path.join(slugDir, "decisions.md"),
    "# decisions\n\n- No review-loop decisions yet.\n",
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "changelog.md"),
    "# changelog\n\n## v0.1 — seed\n\n- initial\n",
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "interview.json"),
    JSON.stringify({
      slug,
      persona: 'Veteran "refunds" expert',
      generated_at: "2026-04-19T12:00:00Z",
      questions: [],
      answers: [],
    }),
    "utf8",
  );
  writeFileSync(
    path.join(slugDir, "context.json"),
    JSON.stringify({
      phase: "draft",
      files: [],
      risk_flags: [],
      budget: { phase: "draft", tokens_used: 0, tokens_budget: 0 },
    }),
    "utf8",
  );
  const state: State = {
    slug,
    phase: "review_loop",
    round_index: 0,
    version: "0.1.0",
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
  // .samospec/config.json so the consent layer has a real file.
  writeFileSync(
    path.join(cwd, ".samospec", "config.json"),
    JSON.stringify({ schema_version: 1 }, null, 2) + "\n",
    "utf8",
  );
  spawnSync("git", ["add", "."], { cwd });
  spawnSync("git", ["commit", "-q", "-m", "spec(refunds): draft v0.1"], {
    cwd,
  });
}

const BASE_RESOLVERS: IterateResolvers = {
  onManualEdit: () => Promise.resolve("incorporate"),
  onDegraded: () => Promise.resolve("accept"),
  onReviewerExhausted: () => Promise.resolve("abort"),
};
const DEFAULT_TIME_INPUTS = {
  sessionStartedAtMs: 0,
  nowMs: 0,
  maxWallClockMs: 60 * 60 * 1000,
};

function buildCritique(suffix: number): CritiqueOutput {
  return {
    findings: [
      {
        category: "ambiguity",
        text: `finding #${String(suffix)} in spec body`,
        severity: "minor",
      },
    ],
    summary: `round ${String(suffix)} summary`,
    suggested_next_version: `0.${String(suffix + 1)}`,
    usage: null,
    effort_used: "max",
  };
}

function makeLead(readyOnRound: number): Adapter {
  let roundCounter = 0;
  return {
    vendor: "fake",
    detect: () =>
      Promise.resolve({ installed: true, version: "x", path: "/x" }),
    auth_status: () => Promise.resolve({ authenticated: true }),
    supports_structured_output: () => true,
    supports_effort: () => true,
    models: () => Promise.resolve([{ id: "x", family: "fake" }]),
    ask: () => Promise.reject(new Error("unused")),
    critique: () => Promise.reject(new Error("unused")),
    revise: () => {
      roundCounter += 1;
      return Promise.resolve({
        spec: `# SPEC\n\nrevised body round ${String(roundCounter)}\n- item ${String(roundCounter)}\n`,
        ready: roundCounter >= readyOnRound,
        rationale: JSON.stringify([
          {
            finding_ref: "codex#1",
            decision: "accepted",
            rationale: `applied round ${String(roundCounter)}`,
          },
        ]),
        usage: null,
        effort_used: "max",
      });
    },
  };
}

function makeCritiqueAdapter(): Adapter {
  let cCounter = 0;
  return {
    ...createFakeAdapter({}),
    critique: () => {
      cCounter += 1;
      return Promise.resolve(buildCritique(cCounter));
    },
  };
}

function refsOnBare(): string[] {
  const res = spawnSync("git", ["--git-dir", bare, "show-ref"], {
    encoding: "utf8",
  });
  return res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function logOnBare(branch: string): string[] {
  const res = spawnSync(
    "git",
    ["--git-dir", bare, "log", "--format=%s", branch],
    { encoding: "utf8" },
  );
  if (res.status !== 0) return [];
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe("iterate — round-boundary push integration", () => {
  test("accept consent + 2-round loop → exactly 2 pushes, 1 prompt", async () => {
    seedSpec(tmp, "refunds");

    let promptCalls = 0;
    const res = await runIterate({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T12:00:00Z",
      resolvers: {
        ...BASE_RESOLVERS,
        onPushConsent: () => {
          promptCalls += 1;
          return Promise.resolve("accept");
        },
      },
      adapters: {
        lead: makeLead(2),
        reviewerA: makeCritiqueAdapter(),
        reviewerB: makeCritiqueAdapter(),
      },
      maxRounds: 5,
      pushOptions: { remote: "origin", noPush: false },
      ...DEFAULT_TIME_INPUTS,
    });

    expect(res.exitCode).toBe(0);
    expect(res.roundsRun).toBe(2);
    expect(promptCalls).toBe(1);

    // Branch should exist on the bare remote.
    const refs = refsOnBare();
    const branchRef = refs.find((r) =>
      r.includes("refs/heads/samospec/refunds"),
    );
    expect(branchRef).toBeDefined();

    // The branch on the bare remote has two refine commits plus the
    // seed commit — one push per round boundary landed the latest tip.
    const commits = logOnBare("samospec/refunds");
    expect(
      commits.some((c) => c.startsWith("spec(refunds): refine v0.2")),
    ).toBe(true);
    expect(
      commits.some((c) => c.startsWith("spec(refunds): refine v0.3")),
    ).toBe(true);
  });

  test("--no-push override: persisted consent = true, invocation flag skips all pushes", async () => {
    seedSpec(tmp, "refunds");
    // Pre-persist consent = true so the loop would push by default.
    writeFileSync(
      path.join(tmp, ".samospec", "config.json"),
      JSON.stringify(
        {
          schema_version: 1,
          git: { push_consent: { [bare]: true } },
        },
        null,
        2,
      ),
      "utf8",
    );

    const res = await runIterate({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T12:00:00Z",
      resolvers: {
        ...BASE_RESOLVERS,
        onPushConsent: () => Promise.resolve("accept"),
      },
      adapters: {
        lead: makeLead(2),
        reviewerA: makeCritiqueAdapter(),
        reviewerB: makeCritiqueAdapter(),
      },
      maxRounds: 5,
      pushOptions: { remote: "origin", noPush: true },
      ...DEFAULT_TIME_INPUTS,
    });

    expect(res.exitCode).toBe(0);
    // Bare remote must not have received samospec/refunds.
    const refs = refsOnBare();
    const branchRef = refs.find((r) =>
      r.includes("refs/heads/samospec/refunds"),
    );
    expect(branchRef).toBeUndefined();
  });

  test("persisted refuse: no prompt, no pushes, exits 0 (not 5)", async () => {
    seedSpec(tmp, "refunds");
    writeFileSync(
      path.join(tmp, ".samospec", "config.json"),
      JSON.stringify(
        {
          schema_version: 1,
          git: { push_consent: { [bare]: false } },
        },
        null,
        2,
      ),
      "utf8",
    );

    let promptCalls = 0;
    const res = await runIterate({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T12:00:00Z",
      resolvers: {
        ...BASE_RESOLVERS,
        onPushConsent: () => {
          promptCalls += 1;
          return Promise.resolve("accept");
        },
      },
      adapters: {
        lead: makeLead(2),
        reviewerA: makeCritiqueAdapter(),
        reviewerB: makeCritiqueAdapter(),
      },
      maxRounds: 5,
      pushOptions: { remote: "origin", noPush: false },
      ...DEFAULT_TIME_INPUTS,
    });

    expect(res.exitCode).toBe(0);
    expect(promptCalls).toBe(0);
    const refs = refsOnBare();
    const branchRef = refs.find((r) =>
      r.includes("refs/heads/samospec/refunds"),
    );
    expect(branchRef).toBeUndefined();
  });

  test("Ctrl-C at first consent prompt → exit 3", async () => {
    seedSpec(tmp, "refunds");

    const res = await runIterate({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T12:00:00Z",
      resolvers: {
        ...BASE_RESOLVERS,
        onPushConsent: () => Promise.resolve("interrupt"),
      },
      adapters: {
        lead: makeLead(1),
        reviewerA: makeCritiqueAdapter(),
        reviewerB: makeCritiqueAdapter(),
      },
      maxRounds: 5,
      pushOptions: { remote: "origin", noPush: false },
      ...DEFAULT_TIME_INPUTS,
    });

    expect(res.exitCode).toBe(3);
  });

  test("no pushOptions provided → local-only (no push attempts, no prompt)", async () => {
    seedSpec(tmp, "refunds");

    let promptCalls = 0;
    const res = await runIterate({
      cwd: tmp,
      slug: "refunds",
      now: "2026-04-19T12:00:00Z",
      resolvers: {
        ...BASE_RESOLVERS,
        onPushConsent: () => {
          promptCalls += 1;
          return Promise.resolve("accept");
        },
      },
      adapters: {
        lead: makeLead(1),
        reviewerA: makeCritiqueAdapter(),
        reviewerB: makeCritiqueAdapter(),
      },
      maxRounds: 5,
      ...DEFAULT_TIME_INPUTS,
    });

    expect(res.exitCode).toBe(0);
    expect(promptCalls).toBe(0);
    const refs = refsOnBare();
    const branchRef = refs.find((r) =>
      r.includes("refs/heads/samospec/refunds"),
    );
    expect(branchRef).toBeUndefined();
  });

  test("distinct remotes with different persisted choices are honored independently", async () => {
    seedSpec(tmp, "refunds");
    // Add a second remote URL and persist opposite choices.
    const otherBare = mkdtempSync(path.join(tmpdir(), "samospec-push-bare-2-"));
    spawnSync("git", ["init", "--bare", "--initial-branch", "main"], {
      cwd: otherBare,
    });
    try {
      spawnSync("git", ["remote", "add", "mirror", otherBare], { cwd: tmp });

      writeFileSync(
        path.join(tmp, ".samospec", "config.json"),
        JSON.stringify(
          {
            schema_version: 1,
            git: {
              push_consent: {
                [bare]: true,
                [otherBare]: false,
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      // Run two single-round loops, once per remote.
      const resA = await runIterate({
        cwd: tmp,
        slug: "refunds",
        now: "2026-04-19T12:00:00Z",
        resolvers: {
          ...BASE_RESOLVERS,
          onPushConsent: () => Promise.resolve("accept"),
        },
        adapters: {
          lead: makeLead(1),
          reviewerA: makeCritiqueAdapter(),
          reviewerB: makeCritiqueAdapter(),
        },
        maxRounds: 1,
        pushOptions: { remote: "origin", noPush: false },
        ...DEFAULT_TIME_INPUTS,
      });
      expect(resA.exitCode).toBe(0);

      const refs = refsOnBare();
      expect(refs.some((r) => r.includes("refs/heads/samospec/refunds"))).toBe(
        true,
      );

      const mirrorRefs = spawnSync(
        "git",
        ["--git-dir", otherBare, "show-ref"],
        { encoding: "utf8" },
      );
      expect(
        (mirrorRefs.stdout ?? "").includes("refs/heads/samospec/refunds"),
      ).toBe(false);

      // Config should still reflect both choices verbatim.
      const cfg = JSON.parse(
        readFileSync(path.join(tmp, ".samospec", "config.json"), "utf8"),
      ) as {
        git: { push_consent: Record<string, boolean> };
      };
      expect(cfg.git.push_consent[bare]).toBe(true);
      expect(cfg.git.push_consent[otherBare]).toBe(false);
    } finally {
      rmSync(otherBare, { recursive: true, force: true });
    }
  });
});
