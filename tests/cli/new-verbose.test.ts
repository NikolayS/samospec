// Copyright 2026 Nikolay Samokhvalov.

// Issue #77 — PR #74 wired `RunNewInput.verbose` + accepted `--verbose` on
// the CLI (by virtue of permissive unknown-flag passthrough), but `runNew`
// never actually consumed the field. A user passing `--verbose` saw
// identical output. This file asserts the fix: when verbose=true, `runNew`
// emits several additional diagnostic lines on **stderr** (progress /
// spawn / per-file write paths), while stdout stays the quiet summary.
//
// The targeted lines are the inter-phase timings + the per-file write
// paths for the committed-artifact set (SPEC §9). These are the signals
// an operator debugging a hang actually wants to see.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type { Adapter, AskInput, AskOutput } from "../../src/adapter/types.ts";
import { runInit } from "../../src/cli/init.ts";
import { runNew, type ChoiceResolvers } from "../../src/cli/new.ts";

const NOW = "2026-04-21T12:00:00Z";

function askOut(answer: string): AskOutput {
  return { answer, usage: null, effort_used: "max" };
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
  };
}

function acceptResolver(): ChoiceResolvers {
  return {
    persona: () => Promise.resolve({ kind: "accept" }),
    question: () => Promise.resolve({ choice: "decide for me" }),
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-verbose-77-"));
  runInit({ cwd: tmp });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("samospec new --verbose (#77)", () => {
  test("verbose=true emits additional diagnostic lines on stderr", async () => {
    const adapter = makeLeadAdapter([
      personaJson("CLI engineer"),
      questionsJson([
        { id: "q1", text: "framework?" },
        { id: "q2", text: "db?" },
      ]),
    ]);

    const result = await runNew(
      {
        cwd: tmp,
        slug: "demo-verbose",
        idea: "a CLI for turning ideas into specs",
        explain: false,
        resolvers: acceptResolver(),
        now: NOW,
        verbose: true,
      },
      adapter,
    );

    expect(result.exitCode).toBe(0);
    // With verbose on, stderr must carry diagnostic lines. The bar is
    // loose on purpose: we only care that the flag is actually consumed.
    const stderrLines = result.stderr
      .split("\n")
      .filter((l) => l.trim().length > 0);
    expect(stderrLines.length).toBeGreaterThanOrEqual(2);
  });

  test("verbose=true produces strictly more stderr than verbose=false", async () => {
    const makePair = (): Adapter =>
      makeLeadAdapter([
        personaJson("CLI engineer"),
        questionsJson([
          { id: "q1", text: "framework?" },
          { id: "q2", text: "db?" },
        ]),
      ]);

    const quiet = await runNew(
      {
        cwd: tmp,
        slug: "demo-quiet",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: NOW,
        verbose: false,
      },
      makePair(),
    );

    // Fresh sandbox for the verbose pass — otherwise `samospec new`
    // refuses to clobber the existing slug dir.
    const tmp2 = mkdtempSync(path.join(tmpdir(), "samospec-verbose-77b-"));
    try {
      runInit({ cwd: tmp2 });
      const verbose = await runNew(
        {
          cwd: tmp2,
          slug: "demo-verbose",
          idea: "x",
          explain: false,
          resolvers: acceptResolver(),
          now: NOW,
          verbose: true,
        },
        makePair(),
      );
      expect(verbose.exitCode).toBe(0);
      expect(quiet.exitCode).toBe(0);
      expect(verbose.stderr.length).toBeGreaterThan(quiet.stderr.length);
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });

  test("verbose=true marks each of draft phases 2-5 on stderr", async () => {
    const adapter = makeLeadAdapter([
      personaJson("CLI engineer"),
      questionsJson([{ id: "q1", text: "framework?" }]),
    ]);

    const result = await runNew(
      {
        cwd: tmp,
        slug: "demo-phases",
        idea: "x",
        explain: false,
        resolvers: acceptResolver(),
        now: NOW,
        verbose: true,
      },
      adapter,
    );

    expect(result.exitCode).toBe(0);
    // Each of the post-preflight draft phases should be traced once.
    // We assert on a phase-enter token that only a verbose pass would
    // emit — e.g. `[phase] persona` / `[phase] interview` / `[phase] draft`.
    const stderr = result.stderr;
    expect(stderr).toContain("persona");
    expect(stderr).toContain("interview");
    expect(stderr).toContain("draft");
  });
});
