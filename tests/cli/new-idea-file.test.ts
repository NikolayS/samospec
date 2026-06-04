// Copyright 2026 Nikolay Samokhvalov.

// `--idea-file` — read the idea from a file (AI/CI ergonomics).
//
// Pins:
//   - loadIdeaFile() reads a file, trims surrounding whitespace, and
//     preserves internal formatting; empty / unreadable files are clear
//     tagged-union errors (tested in isolation, mirroring loadAnswersFile).
//   - parseNewArgs rejects --idea + --idea-file at parse time (exit 1)
//     BEFORE any adapter is constructed.
//   - --idea-file with a missing path surfaces the loader error.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type {
  Adapter,
  ReviseInput,
  ReviseOutput,
  StructuredAskInput,
  StructuredAskOutput,
} from "../../src/adapter/types.ts";
import { loadIdeaFile } from "../../src/cli/non-interactive.ts";
import { runInit } from "../../src/cli/init.ts";
import { runCli } from "../../src/cli.ts";
import { readState } from "../../src/state/store.ts";
import { createTempRepo, type TempRepo } from "../git/helpers/tempRepo.ts";

describe("loadIdeaFile", () => {
  test("reads file contents, trims surrounding whitespace", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "samospec-idea-"));
    try {
      const p = path.join(dir, "idea.md");
      writeFileSync(p, "\n\n  An umbrella CLI for the samo tools.\n\n");
      const r = loadIdeaFile(p);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.idea).toBe("An umbrella CLI for the samo tools.");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves internal multi-paragraph / markdown formatting", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "samospec-idea-"));
    try {
      const p = path.join(dir, "idea.md");
      const body = "# Title\n\n- one\n- two\n\nFinal paragraph.";
      writeFileSync(p, `\n${body}\n`);
      const r = loadIdeaFile(p);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.idea).toBe(body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty / whitespace-only file is an error", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "samospec-idea-"));
    try {
      const p = path.join(dir, "blank.md");
      writeFileSync(p, "   \n\t\n");
      const r = loadIdeaFile(p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("--idea-file is empty");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unreadable / missing file is an error", () => {
    const r = loadIdeaFile("/no/such/idea-file/here.md");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("--idea-file could not be read");
  });
});

describe("samospec new --idea-file — flag coherence", () => {
  test("--idea and --idea-file are mutually exclusive (parse-time, exit 1)", async () => {
    const res = await runCli([
      "new",
      "demo",
      "--idea",
      "x",
      "--idea-file",
      "y.md",
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain(
      "--idea and --idea-file are mutually exclusive",
    );
  });

  test("--idea-file with a missing path surfaces the loader error", async () => {
    const res = await runCli([
      "new",
      "demo",
      "--accept-persona",
      "--idea-file",
      "/no/such/file.md",
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--idea-file could not be read");
  });
});

// ---------- parse-time guard branches (src/cli.ts:443-469) ----------
//
// `--idea-file requires a path` has TWO distinct return branches and the
// equals form `--idea-file=<path>` is a third slicing/validation branch.
// They regress independently, so each is pinned through `runCli` (the only
// public entry that reaches `parseNewArgs`). Parse errors exit 1 with the
// message on stderr, ABOVE the adapter being constructed.

describe("samospec new --idea-file — parse-time path validation", () => {
  test("space form with NO following token => requires a path (exit 1)", async () => {
    // `--idea-file` is the last token; argv[i+1] is undefined → "" → length 0.
    const res = await runCli(["new", "demo", "--idea-file"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--idea-file requires a path");
  });

  test("space form whose next token is a flag (--…) => requires a path (exit 1)", async () => {
    // The guard rejects a value that itself starts with `--` so a forgotten
    // path doesn't silently consume the following flag as the idea path.
    const res = await runCli([
      "new",
      "demo",
      "--idea-file",
      "--accept-persona",
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--idea-file requires a path");
  });

  test("empty equals form `--idea-file=` => requires a path (exit 1)", async () => {
    // Distinct branch (src/cli.ts:452-458): slice yields "" → length 0.
    const res = await runCli(["new", "demo", "--idea-file="]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--idea-file requires a path");
  });
});

// ---------- end-to-end: idea-file text flows into runNew + the spec ----------
//
// The primary success promise of the feature: `samospec new <slug>
// --idea-file <path>` resolves effectiveIdea = loadIdeaFile(path).idea
// (src/cli.ts) and threads it through runNew({idea}) into
// state.input.idea AND the v0.1 draft scaffold/revise call. Every prior
// idea-file test stopped at loadIdeaFile in isolation or at an error exit;
// none asserted the happy path at the CLI level. We drive runCli against a
// scripted fake adapter inside a throwaway repo via the test-only deps seam.

function structuredAskOut(rawJson: string): StructuredAskOutput {
  return { rawJson, usage: null, effort_used: "max" };
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

const E2E_SPEC =
  "# demo spec\n\n## Goal\n\nShip the idea described in the idea file.\n";

function makeIdeaFileAdapter(): {
  adapter: Adapter;
  revises: ReviseInput[];
} {
  const base = createFakeAdapter();
  const revises: ReviseInput[] = [];
  let askCall = 0;
  const answers = [
    personaJson("platform engineer"),
    questionsJson([{ id: "q1", text: "framework?" }]),
  ];
  const adapter: Adapter = {
    ...base,
    structuredAsk: (
      _input: StructuredAskInput,
    ): Promise<StructuredAskOutput> => {
      const a = answers[askCall] ?? answers[answers.length - 1] ?? "{}";
      askCall += 1;
      return Promise.resolve(structuredAskOut(a));
    },
    revise: (input: ReviseInput): Promise<ReviseOutput> => {
      revises.push(input);
      return Promise.resolve({
        spec: E2E_SPEC,
        ready: false,
        rationale: "v0.1 draft complete",
        usage: null,
        effort_used: "max",
      });
    },
  };
  return { adapter, revises };
}

describe("samospec new --idea-file — end-to-end idea wiring (CLI level)", () => {
  let repo: TempRepo;

  beforeEach(() => {
    repo = createTempRepo({ initialBranch: "work" });
    runInit({ cwd: repo.dir });
    repo.run(["add", ".samo"]);
    repo.run(["commit", "-m", "chore: init .samo"]);
  });

  afterEach(() => {
    repo.cleanup();
  });

  test("space form: loaded idea text reaches state.input.idea AND the revise scaffold", async () => {
    const ideaPath = path.join(repo.dir, "IDEA.md");
    const ideaText =
      "# Umbrella CLI\n\nA single entry point for the samo tools.\n\n- new\n- resume";
    // Surrounding whitespace must be trimmed by the loader; assert the
    // trimmed form propagates verbatim (internal formatting preserved).
    writeFileSync(ideaPath, `\n\n${ideaText}\n\n`);

    const { adapter, revises } = makeIdeaFileAdapter();
    const res = await runCli(
      ["new", "demo", "--yes", "--idea-file", ideaPath],
      { newAdapter: adapter, cwd: repo.dir },
    );

    expect(res.exitCode).toBe(0);

    // The committed spec was authored, proving we reached the draft phase
    // (not an early error exit) with the file-sourced idea.
    const slugDir = path.join(repo.dir, ".samo", "spec", "demo");
    const st = readState(path.join(slugDir, "state.json"));
    expect(st).not.toBeNull();
    expect(st!.round_state).toBe("committed");
    // state.input.idea is the loaded (trimmed) idea, NOT the slug fallback.
    expect(st!.input?.idea).toBe(ideaText);
    expect(st!.input?.idea).not.toBe("demo");

    // The idea threaded into the v0.1 draft revise() call: both as the
    // authoritative `idea` field and embedded in the scaffold spec text.
    expect(revises.length).toBe(1);
    const r = revises[0];
    expect(r).toBeDefined();
    expect(r?.idea).toBe(ideaText);
    expect(r?.spec).toContain("## Idea");
    expect(r?.spec).toContain("A single entry point for the samo tools.");

    // The slug fallback ("demo") never leaked in as the idea.
    expect(r?.idea).not.toBe("demo");
  });

  test("equals form `--idea-file=<path>` flows the idea identically (separate branch)", async () => {
    const ideaPath = path.join(repo.dir, "idea.txt");
    const ideaText = "Equals-form idea body that must reach the draft.";
    writeFileSync(ideaPath, `${ideaText}\n`);

    const { adapter, revises } = makeIdeaFileAdapter();
    const res = await runCli(
      ["new", "demo", "--yes", `--idea-file=${ideaPath}`],
      { newAdapter: adapter, cwd: repo.dir },
    );

    expect(res.exitCode).toBe(0);

    const st = readState(
      path.join(repo.dir, ".samo", "spec", "demo", "state.json"),
    );
    expect(st).not.toBeNull();
    expect(st!.input?.idea).toBe(ideaText);

    expect(revises.length).toBe(1);
    expect(revises[0]?.idea).toBe(ideaText);
    expect(revises[0]?.spec).toContain(ideaText);
  });

  test("empty idea file aborts BEFORE the adapter runs (no revise call)", async () => {
    const ideaPath = path.join(repo.dir, "blank.md");
    writeFileSync(ideaPath, "   \n\t\n");

    const { adapter, revises } = makeIdeaFileAdapter();
    const res = await runCli(
      ["new", "demo", "--yes", "--idea-file", ideaPath],
      { newAdapter: adapter, cwd: repo.dir },
    );

    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--idea-file is empty");
    // No spec authored, no revise() invoked.
    expect(revises.length).toBe(0);
  });
});

// ---------- mutual-exclusion: both orders × both --idea forms ----------
//
// `--idea` and `--idea-file` are mutually exclusive. The existing suite
// only covers `--idea x --idea-file y` (space form of --idea). `ideaSeen`
// is also set by the equals branch `--idea=` (src/cli.ts:466-469); the
// guard is order-independent. Pin every combination so dropping either
// form's `ideaSeen` assignment, or reordering the check, fails CI.

describe("samospec new — --idea / --idea-file mutual exclusion (parametric)", () => {
  const cases: readonly {
    readonly name: string;
    readonly argv: readonly string[];
  }[] = [
    {
      name: "space --idea then --idea-file",
      argv: ["new", "demo", "--idea", "x", "--idea-file", "y.md"],
    },
    {
      name: "--idea-file then space --idea",
      argv: ["new", "demo", "--idea-file", "y.md", "--idea", "x"],
    },
    {
      name: "equals --idea= then --idea-file",
      argv: ["new", "demo", "--idea=x", "--idea-file", "y.md"],
    },
    {
      name: "--idea-file then equals --idea=",
      argv: ["new", "demo", "--idea-file", "y.md", "--idea=x"],
    },
    {
      name: "equals --idea= then equals --idea-file=",
      argv: ["new", "demo", "--idea=x", "--idea-file=y.md"],
    },
  ];

  for (const c of cases) {
    test(`${c.name} => mutually exclusive (parse-time, exit 1)`, async () => {
      const res = await runCli(c.argv);
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain(
        "--idea and --idea-file are mutually exclusive",
      );
    });
  }
});
