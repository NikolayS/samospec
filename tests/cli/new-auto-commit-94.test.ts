// Copyright 2026 Nikolay Samokhvalov.

// Regression test for issue #94: `samospec new <slug>` must auto-commit
// its initial draft so that `state.json.round_state === "committed"` is
// truthful with respect to the git tree.
//
// Acceptance criteria (from the issue):
//   (a) a new HEAD commit exists after `new` on the spec branch
//   (b) the commit includes `.samo/spec/<slug>/SPEC.md` + siblings
//   (c) `state.json.round_state === "committed"` is backed by a real
//       clean tree
//   (d) `git status --porcelain` is empty under `.samo/spec/<slug>/`
//
// The happy-path e2e in new.e2e.test.ts already covers the simple case
// where branch creation succeeds. This file pins the harder scenario
// surfaced in issue #93 item 2 → 3: a previous crashed run left the
// `samospec/<slug>` branch behind, so `createSpecBranch` fails with a
// collision. Before the fix, `runNew` silently skipped the commit
// (kind === "skipped"), wrote every artifact, and claimed
// `round_state = "committed"` while the tree was entirely untracked.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type {
  Adapter,
  AskInput,
  AskOutput,
  ReviseInput,
  ReviseOutput,
} from "../../src/adapter/types.ts";
import { runNew, type ChoiceResolvers } from "../../src/cli/new.ts";
import { runInit } from "../../src/cli/init.ts";
import { readState } from "../../src/state/store.ts";
import { createTempRepo, type TempRepo } from "../git/helpers/tempRepo.ts";

// ---------- fixture builders ----------

function askOut(answer: string): AskOutput {
  return { answer, usage: null, effort_used: "max" };
}

function personaJson(skill: string): string {
  return JSON.stringify({
    persona: `Veteran "${skill}" expert`,
    rationale: "pragmatic choice",
  });
}

function questionsJson(items: readonly { id: string; text: string }[]): string {
  return JSON.stringify({
    questions: items.map((q) => ({
      id: q.id,
      text: q.text,
      options: ["opt A", "opt B"],
    })),
  });
}

const SAMPLE_SPEC =
  "# break-reminder spec\n\n" +
  "## Goal\n\nRemind developers to take breaks.\n\n" +
  "## Scope\n\n- CLI\n\n";

function reviseOut(): ReviseOutput {
  return {
    spec: SAMPLE_SPEC,
    ready: false,
    rationale: "v0.1 draft complete",
    usage: null,
    effort_used: "max",
  };
}

interface MakeAdapterArgs {
  readonly answers: readonly string[];
}

function makeAdapter(args: MakeAdapterArgs): {
  adapter: Adapter;
} {
  const base = createFakeAdapter();
  let askCall = 0;
  const adapter: Adapter = {
    ...base,
    ask: (_input: AskInput): Promise<AskOutput> => {
      const a =
        args.answers[askCall] ?? args.answers[args.answers.length - 1] ?? "";
      askCall += 1;
      return Promise.resolve(askOut(a));
    },
    revise: (_input: ReviseInput): Promise<ReviseOutput> =>
      Promise.resolve(reviseOut()),
  };
  return { adapter };
}

function acceptResolver(): ChoiceResolvers {
  return {
    persona: () => Promise.resolve({ kind: "accept" }),
    question: () => Promise.resolve({ choice: "decide for me" }),
  };
}

// ---------- sandbox ----------

let repo: TempRepo;
let tmp: string;

beforeEach(() => {
  // Match the issue repro: main with an initial commit, then a feature
  // branch, then samospec init committed so only the spec dir is new.
  repo = createTempRepo({ initialBranch: "main" });
  tmp = repo.dir;
  repo.run(["checkout", "-b", "feat/spec-test"]);
  runInit({ cwd: tmp });
  repo.run(["add", ".samo"]);
  repo.run(["commit", "-m", "chore: init .samo"]);
});

afterEach(() => {
  repo.cleanup();
});

// ---------- regression test ----------

describe("samospec new — auto-commits initial draft (#94)", () => {
  test("commit happens + tree clean under .samo/spec/<slug>/ after a prior crashed run left samospec/<slug> behind", async () => {
    // Simulate issue #93 item 2 → 3: a previous `new` crashed at persona
    // (or later) but not before `createSpecBranch` created the branch.
    // Back on the feature branch, the slug dir exists with some leftover
    // content. The user reruns with --force, which archives the old dir.
    repo.run(["checkout", "-b", "samospec/spec-test"]);
    repo.run(["checkout", "feat/spec-test"]);

    // Leftover slug dir (pretend the old run partly wrote files here).
    mkdirSync(path.join(tmp, ".samo", "spec", "spec-test"), {
      recursive: true,
    });
    writeFileSync(
      path.join(tmp, ".samo", "spec", "spec-test", "leftover.txt"),
      "old\n",
    );

    const { adapter } = makeAdapter({
      answers: [
        personaJson("test engineer"),
        questionsJson([{ id: "q1", text: "framework?" }]),
      ],
    });

    const result = await runNew(
      {
        cwd: tmp,
        slug: "spec-test",
        idea: "break reminder",
        explain: false,
        force: true,
        resolvers: acceptResolver(),
        now: "2026-04-21T20:00:00Z",
      },
      adapter,
    );

    expect(result.exitCode).toBe(0);

    const slugDir = path.join(tmp, ".samo", "spec", "spec-test");

    // (c) state.json says committed AND is backed by a real commit.
    const st = readState(path.join(slugDir, "state.json"));
    expect(st).not.toBeNull();
    expect(st!.round_state).toBe("committed");

    // (d) `git status --porcelain` is empty under `.samo/spec/<slug>/`.
    const statusRes = spawnSync(
      "git",
      ["status", "--porcelain", path.join(".samo", "spec", "spec-test")],
      { cwd: tmp, encoding: "utf8" },
    );
    expect(statusRes.status).toBe(0);
    expect((statusRes.stdout ?? "").trim()).toBe("");

    // (a) A new HEAD commit exists whose subject follows Conventional
    // Commits + SPEC §8 grammar (`spec(<slug>): draft v0.1`).
    const headSubject = spawnSync("git", ["log", "-1", "--format=%s"], {
      cwd: tmp,
      encoding: "utf8",
    });
    expect(headSubject.status).toBe(0);
    expect((headSubject.stdout ?? "").trim()).toBe(
      "spec(spec-test): draft v0.1",
    );

    // (b) The HEAD commit's diff-tree includes SPEC.md + siblings under
    // the slug dir — and nothing outside of it.
    const filesRes = spawnSync(
      "git",
      ["show", "--pretty=", "--name-only", "HEAD"],
      { cwd: tmp, encoding: "utf8" },
    );
    expect(filesRes.status).toBe(0);
    const files = (filesRes.stdout ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const expected = [
      ".samo/spec/spec-test/SPEC.md",
      ".samo/spec/spec-test/TLDR.md",
      ".samo/spec/spec-test/state.json",
      ".samo/spec/spec-test/interview.json",
      ".samo/spec/spec-test/context.json",
      ".samo/spec/spec-test/decisions.md",
      ".samo/spec/spec-test/changelog.md",
    ];
    for (const f of expected) {
      expect(files).toContain(f);
    }
    for (const f of files) {
      expect(f.startsWith(".samo/spec/spec-test/")).toBe(true);
    }

    // Sanity: SPEC.md persisted the lead's draft verbatim.
    const spec = readFileSync(path.join(slugDir, "SPEC.md"), "utf8");
    expect(spec).toContain("# break-reminder spec");
  });

  // Regression for the must-fix flagged on PR #99 review: when the
  // recovery path enters the `branchResult.kind === "exists"` branch but
  // `checkoutExistingBranch` throws (e.g. a dirty working tree blocks the
  // checkout), HEAD stays on the caller's feature branch. Previously the
  // commit gate still fired `specCommit`, silently leaking the v0.1 spec
  // commit onto `feat/...`. The fix must abort the commit in this case
  // (no new commit on feat, no "committed" claim in state.json).
  test("does not leak v0.1 commit to feat branch when checkoutExistingBranch fails", async () => {
    // Seed `samospec/spec-test` with a committed file at a path that
    // also exists, uncommitted, on `feat/spec-test`. `git checkout
    // samospec/spec-test` will then refuse, simulating the checkout
    // failure the reviewer flagged.
    repo.run(["checkout", "-b", "samospec/spec-test"]);
    writeFileSync(path.join(tmp, "conflict.txt"), "spec-branch content\n");
    repo.run(["add", "conflict.txt"]);
    repo.run(["commit", "-m", "chore: seed conflict.txt on spec branch"]);

    repo.run(["checkout", "feat/spec-test"]);
    // Dirty local change at the same path that would be overwritten by
    // the checkout — vanilla git refuses this without --force.
    writeFileSync(path.join(tmp, "conflict.txt"), "feat-local content\n");

    // Sanity preconditions: we start on feat/spec-test, and the HEAD
    // commit there is the `.samo` init commit from beforeEach.
    expect(repo.currentBranch()).toBe("feat/spec-test");
    const headBeforeRes = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: tmp,
      encoding: "utf8",
    });
    expect(headBeforeRes.status).toBe(0);
    const featHeadBefore = (headBeforeRes.stdout ?? "").trim();
    expect(featHeadBefore.length).toBeGreaterThan(0);

    const { adapter } = makeAdapter({
      answers: [
        personaJson("test engineer"),
        questionsJson([{ id: "q1", text: "framework?" }]),
      ],
    });

    await runNew(
      {
        cwd: tmp,
        slug: "spec-test",
        idea: "break reminder",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-21T20:00:00Z",
      },
      adapter,
    );

    // We are still on feat/spec-test — the checkout failure must have
    // kept us here rather than silently advancing onto samospec/spec-test.
    expect(repo.currentBranch()).toBe("feat/spec-test");

    // (a) No new commit must have landed on feat/spec-test. HEAD must
    // be unchanged from before `runNew`.
    const headAfterRes = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: tmp,
      encoding: "utf8",
    });
    expect(headAfterRes.status).toBe(0);
    expect((headAfterRes.stdout ?? "").trim()).toBe(featHeadBefore);

    // Defensive: the HEAD commit subject on feat/spec-test must NOT be
    // the samospec draft commit subject (no leakage).
    const headSubjectRes = spawnSync("git", ["log", "-1", "--format=%s"], {
      cwd: tmp,
      encoding: "utf8",
    });
    expect(headSubjectRes.status).toBe(0);
    expect((headSubjectRes.stdout ?? "").trim()).not.toBe(
      "spec(spec-test): draft v0.1",
    );

    // (b) state.json.round_state must not lie about a clean "committed"
    // outcome when no commit was made.
    const st = readState(
      path.join(tmp, ".samo", "spec", "spec-test", "state.json"),
    );
    if (st !== null) {
      expect(st.round_state).not.toBe("committed");
    }
  });
});
