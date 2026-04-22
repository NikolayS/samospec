// Copyright 2026 Nikolay Samokhvalov.

// Issue #122 — pin the `--yes` contract for samo.team's headless UI.
//
// The UI spawns `samospec new` without a TTY and depends on these
// invariants. Without this test, a refactor of
// `buildNonInteractiveResolvers` could silently regress the UI flow
// and we would only notice when invocations start hitting the 10-min
// session-wall-clock cap (exit 4) again.
//
// Contract pinned here:
//   - passing `--yes` MUST auto-accept the lead's proposed persona
//     (`state.json.persona.accepted === true`).
//   - every interview answer MUST record `choice === "decide for me"`
//     when the user supplies no answers (`--yes` alone, no
//     `--answers-file`).
//   - NO readline interface is constructed. We prove this by driving
//     `runNew` with the resolvers the CLI picks when `--yes` is set,
//     and asserting those resolvers never `throw` (they are pure
//     promise-returning functions that never touch `process.stdin`).
//   - `runNew` exits 0.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-yes-flag-"));
  runInit({ cwd: tmp });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("samospec new --yes (#122) — headless UI contract", () => {
  test("auto-accepts persona and defaults every answer to 'decide for me'", async () => {
    // Build the resolvers that `cli.ts` picks when `--yes` is present
    // without `--answers-file`. This is the exact call shape in
    // `buildNewResolvers` (src/cli.ts).
    const resolvers: ChoiceResolvers = buildNonInteractiveResolvers({
      acceptPersona: true,
      answers: undefined,
    });

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

    const result = await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "a CLI for turning ideas into specs",
        explain: false,
        resolvers,
        now: "2026-04-21T10:00:00Z",
      },
      adapter,
    );

    // Exits cleanly.
    expect(result.exitCode).toBe(0);

    // state.json.persona.accepted === true — the UI-critical assertion.
    const statePath = path.join(tmp, ".samo", "spec", "demo", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      persona: { skill: string; accepted: boolean };
    };
    expect(state.persona).toBeDefined();
    expect(state.persona.accepted).toBe(true);

    // Every interview answer records `choice: "decide for me"`.
    const interviewPath = path.join(
      tmp,
      ".samo",
      "spec",
      "demo",
      "interview.json",
    );
    const interview = JSON.parse(readFileSync(interviewPath, "utf8")) as {
      answers: readonly { id: string; choice: string }[];
    };
    expect(interview.answers.length).toBe(5);
    for (const a of interview.answers) {
      expect(a.choice).toBe("decide for me");
    }
  });

  test("non-interactive resolvers never read from process.stdin", async () => {
    // Structural proof: drive the same resolvers with stdin wired to
    // something that would deadlock if read from (a paused Readable
    // with no data). If `buildNonInteractiveResolvers` ever reached
    // for readline / process.stdin, this test would hang until the
    // Bun per-test timeout fired. Passing means every call resolved
    // purely — no stdin read was attempted.
    const { Readable } = await import("node:stream");
    const deadStdin = new Readable({
      read() {
        /* never push */
      },
    });
    deadStdin.pause();
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", {
      value: deadStdin,
      configurable: true,
    });
    try {
      const resolvers = buildNonInteractiveResolvers({
        acceptPersona: true,
        answers: undefined,
      });
      const personaChoice = await resolvers.persona({
        persona: 'Veteran "CLI engineer" expert',
        skill: "CLI engineer",
        rationale: "r",
        accepted: false,
      });
      expect(personaChoice.kind).toBe("accept");
      for (let i = 0; i < 5; i += 1) {
        const ans = await resolvers.question({
          id: `q${String(i + 1)}`,
          text: "pick one",
          options: ["opt A", "opt B"],
        });
        expect(ans.choice).toBe("decide for me");
      }
    } finally {
      Object.defineProperty(process, "stdin", {
        value: originalStdin,
        configurable: true,
      });
    }
  });
});
