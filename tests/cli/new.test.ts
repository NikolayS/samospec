// Copyright 2026 Nikolay Samokhvalov.

// Tests for `samospec new <slug>` (SPEC §5 Phases 1-5 end-to-end +
// §7 state persistence + §11 subscription-auth + §10 exit codes).
//
// Issue #15 completed the v0.1 draft flow; these tests now assert the
// post-commit state: phase `draft`, round_state `committed`,
// version `0.1.0`. The earlier skeleton assertions (phase ending at
// `interview`, TODO markers in stdout) have been superseded by the
// end-to-end coverage in `new.e2e.test.ts`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type {
  Adapter,
  AskInput,
  AskOutput,
  AuthStatus,
} from "../../src/adapter/types.ts";
import { readInterview } from "../../src/cli/interview.ts";
import { runNew, type ChoiceResolvers } from "../../src/cli/new.ts";
import { readState } from "../../src/state/store.ts";
import { runInit } from "../../src/cli/init.ts";

function askOut(answer: string): AskOutput {
  return { answer, usage: null, effort_used: "max" };
}

function makeLeadAdapter(
  answers: readonly string[],
  authOverride?: AuthStatus,
): { adapter: Adapter; asks: AskInput[] } {
  const base = createFakeAdapter(
    authOverride !== undefined ? { auth: authOverride } : {},
  );
  const asks: AskInput[] = [];
  let call = 0;
  const adapter: Adapter = {
    ...base,
    ask: (input: AskInput): Promise<AskOutput> => {
      asks.push(input);
      const a = answers[call] ?? answers[answers.length - 1] ?? "";
      call += 1;
      return Promise.resolve(askOut(a));
    },
  };
  return { adapter, asks };
}

const personaJson = (skill: string): string =>
  JSON.stringify({
    persona: `Veteran "${skill}" expert`,
    rationale: "pragmatic choice",
  });

const questionsJson = (
  items: readonly { id: string; text: string }[],
): string =>
  JSON.stringify({
    questions: items.map((q) => ({
      id: q.id,
      text: q.text,
      options: ["opt A", "opt B"],
    })),
  });

function acceptResolver(): ChoiceResolvers {
  return {
    persona: () => Promise.resolve({ kind: "accept" }),
    question: (_q) => Promise.resolve({ choice: "decide for me" }),
  };
}

// ---------- sandbox ----------

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-new-"));
  // A fresh .samo/ is a precondition (SPEC §5 Phase 1).
  runInit({ cwd: tmp });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------- happy path ----------

describe("samospec new <slug> — happy path (SPEC §5 Phases 1-4)", () => {
  test("writes state.json + interview.json and exits 0", async () => {
    const { adapter } = makeLeadAdapter([
      personaJson("CLI engineer"),
      questionsJson([
        { id: "q1", text: "framework?" },
        { id: "q2", text: "db?" },
      ]),
    ]);
    const result = await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "a CLI for turning ideas into specs",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    expect(result.exitCode).toBe(0);

    const slugDir = path.join(tmp, ".samo", "spec", "demo");
    expect(existsSync(slugDir)).toBe(true);
    expect(existsSync(path.join(slugDir, "state.json"))).toBe(true);
    expect(existsSync(path.join(slugDir, "interview.json"))).toBe(true);

    const st = readState(path.join(slugDir, "state.json"));
    expect(st).not.toBeNull();
    expect(st!.slug).toBe("demo");
    expect(st!.persona).toEqual({
      skill: "CLI engineer",
      accepted: true,
    });
    // Phase advances all the way to `draft` now that Issue #15 is
    // merged — end-to-end coverage lives in `new.e2e.test.ts`.
    expect(st!.phase).toBe("draft");

    const iv = readInterview(path.join(slugDir, "interview.json"));
    expect(iv).not.toBeNull();
    expect(iv!.slug).toBe("demo");
    expect(iv!.persona).toBe('Veteran "CLI engineer" expert');
    expect(iv!.answers.length).toBe(2);
  });

  test("stdout announces the preflight estimate + draft outcome", async () => {
    const { adapter } = makeLeadAdapter([
      personaJson("CLI engineer"),
      questionsJson([{ id: "q1", text: "framework?" }]),
    ]);
    const result = await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    // End-to-end wiring: preflight estimate + TL;DR appear.
    expect(result.stdout.toLowerCase()).toMatch(/estimated range/);
    expect(result.stdout.toLowerCase()).toMatch(/tl;dr/);
    expect(result.stdout.toLowerCase()).toMatch(/resume/);
  });
});

// ---------- subscription-auth copy ----------

describe("samospec new — subscription-auth UX message (SPEC §11)", () => {
  test("subscription_auth=true => SPEC §11 copy printed BEFORE first lead call", async () => {
    const { adapter } = makeLeadAdapter(
      [
        personaJson("CLI engineer"),
        questionsJson([{ id: "q1", text: "framework?" }]),
      ],
      {
        authenticated: true,
        subscription_auth: true,
      },
    );
    const result = await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("subscription-auth mode");
    expect(result.stdout).toContain("wall-clock/iteration caps");
  });

  test("subscription_auth=false => message suppressed", async () => {
    const { adapter } = makeLeadAdapter(
      [
        personaJson("CLI engineer"),
        questionsJson([{ id: "q1", text: "framework?" }]),
      ],
      {
        authenticated: true,
        subscription_auth: false,
      },
    );
    const result = await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("subscription-auth mode");
  });
});

// ---------- --explain flag ----------

describe("samospec new --explain (SPEC §4 secondary ICP)", () => {
  test("explain=true reaches the persona AND interview prompts", async () => {
    const { adapter, asks } = makeLeadAdapter([
      personaJson("CLI engineer"),
      questionsJson([{ id: "q1", text: "framework?" }]),
    ]);
    await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "x",
        explain: true,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    // First call (persona) + second call (interview) both carry the
    // plain-English preamble.
    expect(asks.length).toBeGreaterThanOrEqual(2);
    expect(asks[0].prompt.toLowerCase()).toMatch(/plain english/);
    expect(asks[1].prompt.toLowerCase()).toMatch(/plain english/);
  });
});

// ---------- lead_terminal / exit 4 ----------

describe("samospec new — lead_terminal path (SPEC §10 exit codes)", () => {
  test("persona lead_terminal => exit 4 + state.round_state = lead_terminal", async () => {
    // Two malformed persona responses in a row => PersonaTerminalError.
    const { adapter } = makeLeadAdapter([
      JSON.stringify({ persona: "no quotes here", rationale: "" }),
      JSON.stringify({ persona: "still bad", rationale: "" }),
    ]);
    const result = await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    expect(result.exitCode).toBe(4);
    expect(result.stderr.toLowerCase()).toMatch(/lead_terminal|persona/);

    const st = readState(path.join(tmp, ".samo", "spec", "demo", "state.json"));
    expect(st).not.toBeNull();
    expect(st!.round_state).toBe("lead_terminal");
  });
});

// ---------- slug collision ----------

describe("samospec new — slug collision (SPEC §10)", () => {
  test("existing .samo/spec/<slug>/ => exit 1 suggesting resume", async () => {
    mkdirSync(path.join(tmp, ".samo", "spec", "demo"), {
      recursive: true,
    });
    const { adapter } = makeLeadAdapter([personaJson("CLI engineer")]);
    const result = await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toMatch(/resume|already exists/);
  });
});

// ---------- lock contention ----------

describe("samospec new — repo lock (SPEC §7 lockfile)", () => {
  test("pre-existing live lock => exit 2", async () => {
    const lockPath = path.join(tmp, ".samo", ".lock");
    const fakeLock = {
      pid: process.pid,
      started_at: "2026-04-19T10:00:00Z",
      slug: "other",
    };
    // Write a lock that points at our own pid (so isPidAlive=true).
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify(fakeLock), "utf8");
    const { adapter } = makeLeadAdapter([personaJson("CLI engineer")]);
    const result = await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
        // Force a different pid so the lock is "someone else's".
        pid: process.pid + 1,
      },
      adapter,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toLowerCase()).toMatch(/lock|concurrent|another/);
  });
});

// ---------- state.json has slug branch not yet created ----------

describe("samospec new — branch creation guarded by flag (scope guard)", () => {
  test("default createBranch=false => does NOT invoke git checkout", async () => {
    const { adapter } = makeLeadAdapter([
      personaJson("CLI engineer"),
      questionsJson([{ id: "q1", text: "framework?" }]),
    ]);
    let invoked = 0;
    await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
        createBranch: () => {
          invoked += 1;
          return "samospec/demo";
        },
      },
      adapter,
    );
    expect(invoked).toBe(0);
  });

  test("opt-in createBranch=true => stub is invoked exactly once", async () => {
    const { adapter } = makeLeadAdapter([
      personaJson("CLI engineer"),
      questionsJson([{ id: "q1", text: "framework?" }]),
    ]);
    let invoked = 0;
    await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
        enableBranchCreation: true,
        createBranch: () => {
          invoked += 1;
          return "samospec/demo";
        },
      },
      adapter,
    );
    expect(invoked).toBe(1);
  });
});
