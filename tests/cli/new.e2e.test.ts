// Copyright 2026 Nikolay Samokhvalov.

// Sprint 2 exit — end-to-end `samospec new <slug>` against the fake
// adapter. Wires lockfile, preflight+consent, branch, persona, context,
// interview, v0.1 draft via revise(), file writes, first commit, and
// calibration.
//
// Red-first targets (SPEC §15 Sprint 2 exit):
//   1. Happy path: every expected file is created; state at committed
//      v0.1; round_index: 0; branch samospec/<slug>; commit message
//      `spec(<slug>): draft v0.1` on that branch, NOT on the parent.
//   2. Safety invariant: main never receives a samospec commit.
//   3. TLDR.md non-empty and references the slug.
//   4. context.json present with `phase: "draft"`.
//   5. decisions.md + changelog.md present (seed bodies acceptable).
//   6. Calibration array grew by one (rounds_to_converge[-1] === 0).
//   7. lead_terminal on revise() schema fail -> exit 4, specific copy.
//   8. `--no-push` default: no push attempted.
//   9. Subscription-auth: still works; calibration cost is 0.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type {
  Adapter,
  AskInput,
  AskOutput,
  AuthStatus,
  ReviseInput,
  ReviseOutput,
} from "../../src/adapter/types.ts";
import { readInterview } from "../../src/cli/interview.ts";
import { runNew, type ChoiceResolvers } from "../../src/cli/new.ts";
import { runInit } from "../../src/cli/init.ts";
import { readContextJson } from "../../src/context/provenance.ts";
import { readCalibration } from "../../src/policy/calibration.ts";
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
  "# refunds spec\n\n" +
  "## Goal\n\nEnable marketplace-X sellers to issue partial refunds.\n\n" +
  "## Scope\n\n- API\n- UI\n\n" +
  "## Non-goals\n\n- Crypto refunds.\n";

function reviseOut(
  spec: string = SAMPLE_SPEC,
  overrides: Partial<ReviseOutput> = {},
): ReviseOutput {
  return {
    spec,
    ready: false,
    rationale: "v0.1 draft complete",
    usage: null,
    effort_used: "max",
    ...overrides,
  };
}

interface MakeAdapterArgs {
  readonly answers: readonly string[];
  readonly revise: ReviseOutput | (() => Promise<ReviseOutput>);
  readonly auth?: AuthStatus;
}

function makeAdapter(args: MakeAdapterArgs): {
  adapter: Adapter;
  asks: AskInput[];
  revises: ReviseInput[];
} {
  const base = createFakeAdapter(
    args.auth !== undefined ? { auth: args.auth } : {},
  );
  const asks: AskInput[] = [];
  const revises: ReviseInput[] = [];
  let askCall = 0;
  const adapter: Adapter = {
    ...base,
    ask: (input: AskInput): Promise<AskOutput> => {
      asks.push(input);
      const a =
        args.answers[askCall] ?? args.answers[args.answers.length - 1] ?? "";
      askCall += 1;
      return Promise.resolve(askOut(a));
    },
    revise: (input: ReviseInput): Promise<ReviseOutput> => {
      revises.push(input);
      if (typeof args.revise === "function") return args.revise();
      return Promise.resolve(args.revise);
    },
  };
  return { adapter, asks, revises };
}

function acceptResolver(): ChoiceResolvers {
  return {
    persona: () => Promise.resolve({ kind: "accept" }),
    question: (_q) => Promise.resolve({ choice: "decide for me" }),
  };
}

// ---------- sandbox ----------

let repo: TempRepo;
let tmp: string;

beforeEach(() => {
  // Create a real git repo on a non-protected branch so the branch
  // creation step can run.
  repo = createTempRepo({ initialBranch: "work" });
  tmp = repo.dir;
  runInit({ cwd: tmp });
  // Commit the init files so the working tree starts clean.
  repo.run(["add", ".samospec"]);
  repo.run(["commit", "-m", "chore: init .samospec"]);
});

afterEach(() => {
  repo.cleanup();
});

// ---------- happy path ----------

describe("samospec new refunds — end-to-end (SPEC §5 Phase 5 + Sprint 2 exit)", () => {
  test("writes all committed artifacts and makes the first commit on samospec/refunds", async () => {
    const { adapter } = makeAdapter({
      answers: [
        personaJson("payments engineer"),
        questionsJson([
          { id: "q1", text: "framework?" },
          { id: "q2", text: "auth?" },
        ]),
      ],
      revise: reviseOut(),
    });

    const result = await runNew(
      {
        cwd: tmp,
        slug: "refunds",
        idea: "payment refunds for marketplace X",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );

    expect(result.exitCode).toBe(0);

    const slugDir = path.join(tmp, ".samospec", "spec", "refunds");
    // All committed artifacts present (SPEC §9).
    for (const f of [
      "SPEC.md",
      "TLDR.md",
      "state.json",
      "interview.json",
      "context.json",
      "decisions.md",
      "changelog.md",
    ]) {
      expect(existsSync(path.join(slugDir, f))).toBe(true);
    }

    // state.json at committed, round 0, v0.1.
    const st = readState(path.join(slugDir, "state.json"));
    expect(st).not.toBeNull();
    expect(st!.phase).toBe("draft");
    expect(st!.round_state).toBe("committed");
    expect(st!.round_index).toBe(0);
    expect(st!.version).toBe("0.1.0");

    // SPEC.md contents match the adapter's revise output.
    const spec = readFileSync(path.join(slugDir, "SPEC.md"), "utf8");
    expect(spec).toContain("# refunds spec");

    // TLDR.md non-empty, starts with "# TL;DR", references the slug.
    const tldr = readFileSync(path.join(slugDir, "TLDR.md"), "utf8");
    expect(tldr.startsWith("# TL;DR")).toBe(true);
    expect(tldr).toContain("samospec resume refunds");

    // context.json present and in draft phase.
    const ctx = readContextJson(path.join(slugDir, "context.json"));
    expect(ctx).not.toBeNull();
    expect(ctx!.phase).toBe("draft");

    // interview.json persisted.
    const iv = readInterview(path.join(slugDir, "interview.json"));
    expect(iv).not.toBeNull();
    expect(iv!.answers.length).toBe(2);

    // Branch creation: samospec/refunds exists, is the current branch,
    // and carries the v0.1 commit.
    expect(repo.listBranches()).toContain("samospec/refunds");
    expect(repo.currentBranch()).toBe("samospec/refunds");
    const log = repo.logOnBranch("samospec/refunds");
    expect(log[0]).toBe("spec(refunds): draft v0.1");

    // Safety invariant: main/master NEVER receives the draft commit.
    const mainLog = repo.logOnBranch("main");
    expect(mainLog).not.toContain("spec(refunds): draft v0.1");
    const masterLog = repo.logOnBranch("master");
    expect(masterLog).not.toContain("spec(refunds): draft v0.1");
    const workLog = repo.logOnBranch("work");
    expect(workLog).not.toContain("spec(refunds): draft v0.1");
  });

  test("commit staged files are ONLY the samospec spec dir (never `add -A`)", async () => {
    const { adapter } = makeAdapter({
      answers: [
        personaJson("payments engineer"),
        questionsJson([{ id: "q1", text: "framework?" }]),
      ],
      revise: reviseOut(),
    });
    // Drop an unrelated untracked file; it must NOT end up in the commit.
    writeFileSync(path.join(tmp, "NOT_STAGED.md"), "noise\n");

    await runNew(
      {
        cwd: tmp,
        slug: "refunds",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );

    // The commit's diff-tree should only list files under .samospec/spec/refunds/.
    const diffRes = spawnSync(
      "git",
      ["show", "--pretty=", "--name-only", "samospec/refunds"],
      { cwd: tmp, encoding: "utf8" },
    );
    const files = (diffRes.stdout ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const f of files) {
      expect(f.startsWith(".samospec/spec/refunds/")).toBe(true);
    }
    expect(files).not.toContain("NOT_STAGED.md");
  });

  test("passes an empty reviews array and decisions_history to revise()", async () => {
    const { adapter, revises } = makeAdapter({
      answers: [
        personaJson("payments engineer"),
        questionsJson([{ id: "q1", text: "framework?" }]),
      ],
      revise: reviseOut(),
    });
    await runNew(
      {
        cwd: tmp,
        slug: "refunds",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    expect(revises.length).toBe(1);
    const r = revises[0];
    expect(r).toBeDefined();
    expect(r?.reviews).toEqual([]);
    expect(r?.decisions_history).toEqual([]);
    expect(r?.opts.effort).toBe("max");
    expect(r?.opts.timeout).toBe(600_000);
  });

  test("calibration array is appended by exactly one sample (rounds = 0)", async () => {
    const { adapter } = makeAdapter({
      answers: [
        personaJson("payments engineer"),
        questionsJson([{ id: "q1", text: "framework?" }]),
      ],
      revise: reviseOut(),
    });
    await runNew(
      {
        cwd: tmp,
        slug: "refunds",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    const config = JSON.parse(
      readFileSync(path.join(tmp, ".samospec", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    const cal = readCalibration(config);
    expect(cal).not.toBeNull();
    expect(cal!.sample_count).toBe(1);
    expect(cal!.rounds_to_converge).toEqual([0]);
  });

  test("stdout prints preflight estimate + TL;DR + resume hint", async () => {
    const { adapter } = makeAdapter({
      answers: [
        personaJson("payments engineer"),
        questionsJson([{ id: "q1", text: "framework?" }]),
      ],
      revise: reviseOut(),
    });
    const result = await runNew(
      {
        cwd: tmp,
        slug: "refunds",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    expect(result.stdout.toLowerCase()).toMatch(/estimated range|preflight/);
    expect(result.stdout.toLowerCase()).toMatch(/tl;dr|tldr/);
    expect(result.stdout).toContain("samospec resume refunds");
  });
});

// ---------- subscription-auth path ----------

describe("samospec new refunds — subscription-auth (SPEC §11)", () => {
  test("runs end-to-end with null usage; calibration cost stored as 0", async () => {
    const { adapter } = makeAdapter({
      answers: [
        personaJson("payments engineer"),
        questionsJson([{ id: "q1", text: "framework?" }]),
      ],
      revise: reviseOut(),
      auth: {
        authenticated: true,
        subscription_auth: true,
      },
    });
    const result = await runNew(
      {
        cwd: tmp,
        slug: "refunds",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    expect(result.exitCode).toBe(0);
    const config = JSON.parse(
      readFileSync(path.join(tmp, ".samospec", "config.json"), "utf8"),
    ) as Record<string, unknown>;
    const cal = readCalibration(config);
    expect(cal).not.toBeNull();
    expect(cal!.cost_per_run_usd).toEqual([0]);
    // Subscription-auth UX copy shown.
    expect(result.stdout).toContain("subscription-auth mode");
  });
});

// ---------- lead_terminal on draft ----------

describe("samospec new refunds — lead_terminal on draft (SPEC §7)", () => {
  test("adapter.revise rejection => exit 4, state at lead_terminal, specific message", async () => {
    const { adapter } = makeAdapter({
      answers: [
        personaJson("payments engineer"),
        questionsJson([{ id: "q1", text: "framework?" }]),
      ],
      revise: () =>
        Promise.reject(new Error("model refused the draft request")),
    });
    const result = await runNew(
      {
        cwd: tmp,
        slug: "refunds",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    expect(result.exitCode).toBe(4);
    expect(result.stderr.toLowerCase()).toMatch(/lead_terminal|refused/);
    // The state was persisted at lead_terminal.
    const st = readState(
      path.join(tmp, ".samospec", "spec", "refunds", "state.json"),
    );
    expect(st).not.toBeNull();
    expect(st!.round_state).toBe("lead_terminal");
  });

  test("schema_fail sub-reason surfaces the specific copy", async () => {
    const { adapter } = makeAdapter({
      answers: [
        personaJson("payments engineer"),
        questionsJson([{ id: "q1", text: "framework?" }]),
      ],
      revise: () =>
        Promise.reject(new Error("schema_violation after repair retry")),
    });
    const result = await runNew(
      {
        cwd: tmp,
        slug: "refunds",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    expect(result.exitCode).toBe(4);
    expect(result.stderr.toLowerCase()).toMatch(
      /invalid structured output|schema/,
    );
  });
});

// ---------- protected branch refusal ----------

describe("samospec new refunds — refuses commits on protected branches (SPEC §8)", () => {
  test("running from main refuses to create samospec/<slug> and exits 2", async () => {
    // Close the tmp-branch repo and replace with a main-branch one.
    repo.cleanup();
    repo = createTempRepo({ initialBranch: "main" });
    tmp = repo.dir;
    runInit({ cwd: tmp });
    repo.run(["add", ".samospec"]);
    repo.run(["commit", "-m", "chore: init .samospec"]);

    const { adapter } = makeAdapter({
      answers: [
        personaJson("payments engineer"),
        questionsJson([{ id: "q1", text: "framework?" }]),
      ],
      revise: reviseOut(),
    });
    const result = await runNew(
      {
        cwd: tmp,
        slug: "refunds",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    expect(result.exitCode).toBe(2);
    // No samospec/refunds branch exists.
    expect(repo.listBranches()).not.toContain("samospec/refunds");
  });
});

// ---------- consent gate (preflight above threshold) ----------

describe("samospec new refunds — consent gate (SPEC §5 Phase 1)", () => {
  test("abort consent => exit 5 and no commit", async () => {
    const { adapter } = makeAdapter({
      answers: [
        personaJson("payments engineer"),
        questionsJson([{ id: "q1", text: "framework?" }]),
      ],
      revise: reviseOut(),
      auth: { authenticated: true, subscription_auth: true },
    });
    const result = await runNew(
      {
        cwd: tmp,
        slug: "refunds",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
        // Subscription-auth trips the consent gate; test aborts.
        consentAnswer: "abort",
      },
      adapter,
    );
    expect(result.exitCode).toBe(5);
    expect(repo.listBranches()).not.toContain("samospec/refunds");
  });
});

// ---------- slug collision (compat with skeleton test) ----------

describe("samospec new refunds — slug collision still exits 1", () => {
  test("existing spec dir => exit 1 with resume hint", async () => {
    mkdirSync(path.join(tmp, ".samospec", "spec", "refunds"), {
      recursive: true,
    });
    const { adapter } = makeAdapter({
      answers: [personaJson("payments engineer")],
      revise: reviseOut(),
    });
    const result = await runNew(
      {
        cwd: tmp,
        slug: "refunds",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    expect(result.exitCode).toBe(1);
  });
});
