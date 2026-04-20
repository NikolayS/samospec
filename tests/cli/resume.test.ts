// Copyright 2026 Nikolay Samokhvalov.

// Tests for `samospec resume [<slug>]` (SPEC §5 / §7).
// Specific red target (SPEC §13 indirectly): state persistence across
// kill + resume — persona written, interview unstarted -> resume re-
// enters interview; interview done -> resume prints "next phase" and
// exits 0.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type { Adapter, AskInput, AskOutput } from "../../src/adapter/types.ts";
import { runInit } from "../../src/cli/init.ts";
import { runNew, type ChoiceResolvers } from "../../src/cli/new.ts";
import { runResume } from "../../src/cli/resume.ts";
import { readState } from "../../src/state/store.ts";
import { readInterview } from "../../src/cli/interview.ts";

function askOut(answer: string): AskOutput {
  return { answer, usage: null, effort_used: "max" };
}

function makeLeadAdapter(answers: readonly string[]): {
  adapter: Adapter;
  asks: AskInput[];
} {
  const base = createFakeAdapter();
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
    rationale: "pragmatic",
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
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-resume-"));
  runInit({ cwd: tmp });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------- no spec => exit 1 ----------

describe("samospec resume — error cases", () => {
  test("no spec directory at all => exit 1 with remediation hint", async () => {
    const { adapter } = makeLeadAdapter([]);
    const result = await runResume(
      {
        cwd: tmp,
        slug: "demo",
        now: "2026-04-19T11:00:00Z",
        resolvers: acceptResolver(),
      },
      adapter,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toMatch(/no spec|not found/);
  });
});

// ---------- resume after persona, before interview ----------

describe("samospec resume — kill after persona, before interview", () => {
  test("resume picks up at the interview phase and completes the run", async () => {
    // Simulate a run that writes state.json up to the persona phase
    // and crashes before the interview starts. We reproduce this by
    // driving runNew to fail at interview time (empty answers array +
    // onQuestion that throws), then invoking runResume.
    const { adapter: killAdapter } = makeLeadAdapter([
      personaJson("CLI engineer"),
      questionsJson([{ id: "q1", text: "framework?" }]),
    ]);
    const killResolvers: ChoiceResolvers = {
      persona: () => Promise.resolve({ kind: "accept" }),
      question: (_q) => Promise.reject(new Error("simulated kill")),
    };
    const first = await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "x",
        explain: false,
        resolvers: killResolvers,
        now: "2026-04-19T10:00:00Z",
      },
      killAdapter,
    );
    // A kill mid-interview is a non-zero exit (interrupted, exit 3).
    expect(first.exitCode).not.toBe(0);

    const slugDir = path.join(tmp, ".samospec", "spec", "demo");
    const st = readState(path.join(slugDir, "state.json"));
    expect(st).not.toBeNull();
    expect(st!.persona).not.toBeNull();

    // interview.json should NOT be present yet.
    expect(existsSync(path.join(slugDir, "interview.json"))).toBe(false);

    // Now resume with a working question-answerer.
    const { adapter: resumeAdapter } = makeLeadAdapter([
      // The first ask on resume is the interview ask; persona is already
      // written, so resume skips re-proposing.
      questionsJson([
        { id: "q1", text: "framework?" },
        { id: "q2", text: "db?" },
      ]),
    ]);
    const second = await runResume(
      {
        cwd: tmp,
        slug: "demo",
        now: "2026-04-19T11:00:00Z",
        resolvers: acceptResolver(),
      },
      resumeAdapter,
    );
    expect(second.exitCode).toBe(0);
    expect(existsSync(path.join(slugDir, "interview.json"))).toBe(true);

    const iv = readInterview(path.join(slugDir, "interview.json"));
    expect(iv).not.toBeNull();
    expect(iv!.answers.length).toBe(2);
    expect(iv!.persona).toBe('Veteran "CLI engineer" expert');
  });
});

// ---------- resume after interview ----------

describe("samospec resume — interview already complete", () => {
  test("prints 'ready for review loop (Sprint 3)' and exits 0", async () => {
    // Run a full new; then resume.
    const { adapter: newAdapter } = makeLeadAdapter([
      personaJson("CLI engineer"),
      questionsJson([{ id: "q1", text: "framework?" }]),
    ]);
    await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      newAdapter,
    );

    const { adapter: resumeAdapter } = makeLeadAdapter([]);
    const result = await runResume(
      {
        cwd: tmp,
        slug: "demo",
        now: "2026-04-19T11:00:00Z",
        resolvers: acceptResolver(),
      },
      resumeAdapter,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toMatch(
      /ready for review loop|sprint 3/,
    );
  });
});

// ---------- resume at lead_terminal ----------

describe("samospec resume — lead_terminal", () => {
  test("resume at lead_terminal exits 4 and preserves state", async () => {
    // Drive runNew into lead_terminal via two malformed persona outputs.
    const { adapter: newAdapter } = makeLeadAdapter([
      JSON.stringify({ persona: "no quotes", rationale: "" }),
      JSON.stringify({ persona: "still bad", rationale: "" }),
    ]);
    const first = await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      newAdapter,
    );
    expect(first.exitCode).toBe(4);

    const { adapter: resumeAdapter } = makeLeadAdapter([]);
    const result = await runResume(
      {
        cwd: tmp,
        slug: "demo",
        now: "2026-04-19T11:00:00Z",
        resolvers: acceptResolver(),
      },
      resumeAdapter,
    );
    expect(result.exitCode).toBe(4);
    expect(result.stderr.toLowerCase()).toMatch(/lead_terminal/);
  });
});
