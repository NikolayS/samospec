// Copyright 2026 Nikolay Samokhvalov.

// Issue #114 — `samospec new --accept-persona` skips the persona prompt
// entirely and accepts the lead's proposal as-is. Combined with an
// `--answers-file` a fully non-interactive happy path completes under
// non-TTY stdin. This is the primary automation / CI path.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type {
  Adapter,
  AskInput,
  AskOutput,
  ReviseInput,
  ReviseOutput,
} from "../../src/adapter/types.ts";
import { runInit } from "../../src/cli/init.ts";
import { runNew, type ChoiceResolvers } from "../../src/cli/new.ts";
import { buildNonInteractiveResolvers } from "../../src/cli/non-interactive.ts";

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

function makeLeadAdapter(answers: readonly string[]): Adapter {
  const base = createFakeAdapter({});
  let call = 0;
  return {
    ...base,
    ask: (_input: AskInput): Promise<AskOutput> => {
      const a = answers[call] ?? answers[answers.length - 1] ?? "";
      call += 1;
      return Promise.resolve(askOut(a));
    },
    revise: (_input: ReviseInput): Promise<ReviseOutput> =>
      Promise.resolve({
        spec: "# spec\n\n## Goal\nshort\n\n## Scope\n- x\n\n## Non-goals\n- none\n",
        ready: false,
        rationale: "v0.1 draft complete",
        usage: null,
        effort_used: "max",
      }),
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-accept-persona-"));
  runInit({ cwd: tmp });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("buildNonInteractiveResolvers (#114) — --accept-persona", () => {
  test("returns resolvers whose persona always accepts and question uses canned answer", async () => {
    const resolvers = buildNonInteractiveResolvers({
      acceptPersona: true,
      answers: undefined,
    });
    const choice = await resolvers.persona({
      persona: 'Veteran "x" expert',
      skill: "x",
      rationale: "r",
      accepted: false,
    });
    expect(choice.kind).toBe("accept");
  });

  test("defaults to 'decide for me' when no answers supplied", async () => {
    const resolvers = buildNonInteractiveResolvers({
      acceptPersona: true,
      answers: undefined,
    });
    const r = await resolvers.question({
      id: "q1",
      text: "pick?",
      options: ["opt A", "opt B"],
    });
    expect(r.choice).toBe("decide for me");
  });
});

describe("samospec new — --accept-persona + answers-file end-to-end", () => {
  test("fully non-interactive happy path completes (no readline)", async () => {
    const answersPath = path.join(tmp, "answers.json");
    writeFileSync(
      answersPath,
      JSON.stringify({
        answers: ["opt A", "opt B", "opt A", "opt B", "opt A"],
      }),
      "utf8",
    );

    const adapter = makeLeadAdapter([
      personaJson("CLI engineer"),
      questionsJson([
        { id: "q1", text: "framework?" },
        { id: "q2", text: "db?" },
        { id: "q3", text: "host?" },
        { id: "q4", text: "lang?" },
        { id: "q5", text: "auth?" },
      ]),
    ]);

    const resolvers: ChoiceResolvers = buildNonInteractiveResolvers({
      acceptPersona: true,
      answers: ["opt A", "opt B", "opt A", "opt B", "opt A"],
    });

    const result = await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "a CLI for turning ideas into specs",
        explain: false,
        resolvers,
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    expect(result.exitCode).toBe(0);
  });
});
