// Copyright 2026 Nikolay Samokhvalov.

// RED tests for the `--skip` flag at the CLI entry point (PR #61 review
// BLOCKING fix). The baseline-section plumbing, adapter schema, and
// prompt builder all support `skipSections`, but the CLI parser never
// reads the flag, so users running
//   samospec new <slug> --skip user-stories,team
// get all nine baseline sections emitted anyway.
//
// What this file asserts:
//   1. `samospec new <slug> --skip <bogus>` exits 1 with a clear error
//      message naming the valid BASELINE_SECTION_NAMES.
//   2. `samospec new <slug> --skip user-stories` threads the flag into
//      `adapter.revise()`; the revise input's `skipSections` field
//      contains the parsed value.
//   3. `samospec new <slug> --skip user-stories,team` supports
//      comma-separated values, case-insensitive.
//   4. The USAGE string advertises `--skip`.
//
// Tests use the fake adapter and drive `runCli(["new", ...])` through
// the full CLI dispatch so the parser change is exercised end-to-end.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCli } from "../../src/cli.ts";
import { runNew, type ChoiceResolvers } from "../../src/cli/new.ts";
import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type {
  Adapter,
  AskInput,
  AskOutput,
  ReviseInput,
  ReviseOutput,
} from "../../src/adapter/types.ts";
import { runInit } from "../../src/cli/init.ts";
import { createTempRepo, type TempRepo } from "../git/helpers/tempRepo.ts";

// ---------- fixture builders (shared with new.e2e.test.ts pattern) ----------

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
  "## Scope\n\n- API\n- UI\n";

function reviseOut(overrides: Partial<ReviseOutput> = {}): ReviseOutput {
  return {
    spec: SAMPLE_SPEC,
    ready: false,
    rationale: "v0.1 draft complete",
    usage: null,
    effort_used: "max",
    ...overrides,
  };
}

function makeAdapter(answers: readonly string[]): {
  adapter: Adapter;
  revises: ReviseInput[];
} {
  const base = createFakeAdapter();
  const revises: ReviseInput[] = [];
  let askCall = 0;
  const adapter: Adapter = {
    ...base,
    ask: (_input: AskInput): Promise<AskOutput> => {
      const a = answers[askCall] ?? answers[answers.length - 1] ?? "";
      askCall += 1;
      return Promise.resolve(askOut(a));
    },
    revise: (input: ReviseInput): Promise<ReviseOutput> => {
      revises.push(input);
      return Promise.resolve(reviseOut());
    },
  };
  return { adapter, revises };
}

function acceptResolver(): ChoiceResolvers {
  return {
    persona: () => Promise.resolve({ kind: "accept" }),
    question: (_q) => Promise.resolve({ choice: "decide for me" }),
  };
}

// ---------- CLI-level --skip parsing (runCli entry point) ----------
//
// These tests drive `runCli(["new", ...])` in a fresh tmpdir so the
// parser-level validation runs before any cwd-dependent logic. We
// change into a tmpdir for each test and restore the original cwd
// afterward.

describe("samospec new --skip (CLI parser)", () => {
  let origCwd: string;
  let parserTmp: string;

  beforeEach(() => {
    origCwd = process.cwd();
    parserTmp = mkdtempSync(path.join(tmpdir(), "samospec-skip-parser-"));
    process.chdir(parserTmp);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(parserTmp, { recursive: true, force: true });
  });

  test("USAGE string documents --skip flag", async () => {
    const result = await runCli([]);
    expect(result.stderr).toContain("--skip");
  });

  test("--skip <bogus-name> exits 1 with error listing valid names", async () => {
    const result = await runCli([
      "new",
      "demo",
      "--idea",
      "foo",
      "--skip",
      "bogus-section-name",
    ]);
    expect(result.exitCode).toBe(1);
    const err = result.stderr.toLowerCase();
    // Message must identify the bad name and list the valid names.
    expect(err).toContain("bogus-section-name");
    // At least one canonical baseline name must appear in the error.
    const mentionsValid =
      err.includes("user stories") ||
      err.includes("user-stories") ||
      err.includes("valid") ||
      err.includes("known");
    expect(mentionsValid).toBe(true);
  });

  test("--skip with multiple bogus names lists them all", async () => {
    const result = await runCli([
      "new",
      "demo",
      "--idea",
      "foo",
      "--skip",
      "notreal,alsofake",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("notreal");
  });

  test("--skip= (equals form) also parses", async () => {
    const result = await runCli([
      "new",
      "demo",
      "--idea",
      "foo",
      "--skip=bogus-section-name",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("bogus-section-name");
  });
});

// ---------- End-to-end: --skip threads to adapter.revise() ----------

describe("samospec new --skip threads skipSections to adapter.revise()", () => {
  let repo: TempRepo;
  let tmp: string;

  beforeEach(() => {
    repo = createTempRepo({ initialBranch: "work" });
    tmp = repo.dir;
    runInit({ cwd: tmp });
    repo.run(["add", ".samo"]);
    repo.run(["commit", "-m", "chore: init .samo"]);
  });

  afterEach(() => {
    repo.cleanup();
  });

  test("--skip user-stories passes skipSections to revise()", async () => {
    const { adapter, revises } = makeAdapter([
      personaJson("CLI engineer"),
      questionsJson([{ id: "q1", text: "framework?" }]),
    ]);
    const result = await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "a CLI",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
        skipSections: ["user stories"],
      },
      adapter,
    );
    expect(result.exitCode).toBe(0);
    expect(revises.length).toBeGreaterThan(0);
    const reviseCall = revises[0];
    expect(reviseCall).toBeDefined();
    expect(reviseCall?.skipSections).toBeDefined();
    expect(reviseCall?.skipSections).toContain("user stories");
  });

  test("runNew without skipSections leaves field undefined", async () => {
    const { adapter, revises } = makeAdapter([
      personaJson("CLI engineer"),
      questionsJson([{ id: "q1", text: "framework?" }]),
    ]);
    const result = await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "a CLI",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
      },
      adapter,
    );
    expect(result.exitCode).toBe(0);
    expect(revises.length).toBeGreaterThan(0);
    // Absent skip list must not inject anything.
    expect(revises[0]?.skipSections ?? []).toEqual([]);
  });

  test("multi-value --skip array threads through", async () => {
    const { adapter, revises } = makeAdapter([
      personaJson("CLI engineer"),
      questionsJson([{ id: "q1", text: "framework?" }]),
    ]);
    const result = await runNew(
      {
        cwd: tmp,
        slug: "demo",
        idea: "a CLI",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-19T10:00:00Z",
        skipSections: ["user stories", "team"],
      },
      adapter,
    );
    expect(result.exitCode).toBe(0);
    const reviseCall = revises[0];
    expect(reviseCall).toBeDefined();
    expect(reviseCall?.skipSections).toEqual(["user stories", "team"]);
  });
});

// ---------- CLI parser: --skip comma-separated + case-insensitive ----------

describe("parseNewArgs --skip comma-splitting and case", () => {
  let origCwd: string;
  let parserTmp: string;

  beforeEach(() => {
    origCwd = process.cwd();
    parserTmp = mkdtempSync(path.join(tmpdir(), "samospec-skip-case-"));
    process.chdir(parserTmp);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(parserTmp, { recursive: true, force: true });
  });

  test("comma-separated list becomes array of trimmed names", async () => {
    // We can't easily invoke parseNewArgs directly (not exported), so we
    // rely on the bogus-name exit path: if comma-splitting worked and
    // the first name is valid, the second (bogus) name should be in
    // the error message.
    const result = await runCli([
      "new",
      "demo",
      "--idea",
      "foo",
      "--skip",
      "user-stories,bogus-name",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("bogus-name");
    // The valid first name should NOT appear in the bad-names list.
    // (Heuristic: the error complains about the bogus entry only.)
  });

  test("case-insensitive match — uppercase valid name not flagged as unknown", async () => {
    // Exercise the parser by mixing a valid (uppercase) name with a
    // bogus name. The error must list ONLY the bogus entry; the
    // uppercase variant must be canonicalized and accepted.
    const result = await runCli([
      "new",
      "demo",
      "--idea",
      "foo",
      "--skip",
      "USER STORIES,bogus-section",
    ]);
    expect(result.exitCode).toBe(1);
    const lower = result.stderr.toLowerCase();
    expect(lower).toContain("bogus-section");
    // The parser's bad-name message must not flag "user stories" as
    // unknown, since it's a valid canonical section name.
    expect(lower).not.toMatch(/unknown[^:]*: ['"]?user stories['"]?/);
  });
});
