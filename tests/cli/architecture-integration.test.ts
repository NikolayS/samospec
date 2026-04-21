// Copyright 2026 Nikolay Samokhvalov.

// SPEC §3 + Issue #107 — integration tests asserting that `samospec
// new` emits an architecture.json and a sentinel-delimited ASCII block
// in SPEC.md, and that iterate re-renders the block from architecture
// .json on each round.
//
// Red-first: the hooks assert artifacts the current new/iterate don't
// yet produce.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type { Adapter, AskInput, AskOutput } from "../../src/adapter/types.ts";
import { runNew, type ChoiceResolvers } from "../../src/cli/new.ts";
import { runInit } from "../../src/cli/init.ts";
import { parseArchitecture } from "../../src/state/architecture.ts";

function askOut(answer: string): AskOutput {
  return { answer, usage: null, effort_used: "max" };
}

function makeLeadAdapter(): Adapter {
  const base = createFakeAdapter();
  let call = 0;
  const canned = [
    // persona
    JSON.stringify({
      persona: 'Veteran "CLI tooling" expert',
      rationale: "Matches the idea.",
    }),
    // interview Q1..Q5
    JSON.stringify({ id: "Q1", text: "q?", options: [{ id: "a", text: "a" }] }),
    JSON.stringify({ id: "Q2", text: "q?", options: [{ id: "a", text: "a" }] }),
    JSON.stringify({ id: "Q3", text: "q?", options: [{ id: "a", text: "a" }] }),
    JSON.stringify({ id: "Q4", text: "q?", options: [{ id: "a", text: "a" }] }),
    JSON.stringify({ id: "Q5", text: "q?", options: [{ id: "a", text: "a" }] }),
  ];
  const ask = (input: AskInput): Promise<AskOutput> => {
    const out = canned[call] ?? "{}";
    call += 1;
    return Promise.resolve(askOut(out));
  };
  return {
    ...base,
    vendor: "fake-lead",
    ask,
    revise: () =>
      Promise.resolve({
        spec:
          "# arch-demo\n\n## 3. Architecture\n\nPlaceholder prose.\n\n" +
          "## 4. Other\n\nMore text.\n",
        ready: false,
        rationale: "first draft",
        usage: null,
        effort_used: "max",
      }),
  };
}

async function runNewWithArchitecture(cwd: string, slug: string) {
  await runInit({
    cwd,
    force: true,
    yes: true,
    interactiveFn: (): Promise<boolean> => Promise.resolve(true),
  });
  const adapter = makeLeadAdapter();
  const resolvers: ChoiceResolvers = {
    persona: () => Promise.resolve({ kind: "accept" }),
    question: (_q) => Promise.resolve({ kind: "choice", choice: "a" }),
  };
  return await runNew(
    {
      cwd,
      slug,
      idea: "a CLI that emits architecture diagrams",
      explain: false,
      resolvers,
      now: "2026-04-21T00:00:00.000Z",
      noPush: true,
    },
    adapter,
  );
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "arch107-"));
  // Initialize a git repo so `samospec new` can branch + commit.
  spawnSync("git", ["init", "--initial-branch=main", tmpRoot], {
    encoding: "utf8",
  });
  spawnSync("git", ["-C", tmpRoot, "config", "user.email", "a@b.c"]);
  spawnSync("git", ["-C", tmpRoot, "config", "user.name", "Test"]);
  // Seed a minimal commit so HEAD resolves.
  writeFileSync(path.join(tmpRoot, "README.md"), "seed\n");
  spawnSync("git", ["-C", tmpRoot, "add", "README.md"]);
  spawnSync("git", ["-C", tmpRoot, "commit", "-m", "seed"]);
});

afterEach(() => {
  if (tmpRoot !== undefined) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("samospec iterate — architecture block re-render (#107)", () => {
  test("re-renders the SPEC.md block from architecture.json each round", async () => {
    // Lazily import iterate helpers to avoid a top-level circular build path.
    const { runIterate } = await import("../../src/cli/iterate.ts");
    const { writeState } = await import("../../src/state/store.ts");
    const { writeArchitecture } = await import(
      "../../src/state/architecture-store.ts"
    );
    const slug = "arch-iter";
    const slugDir = path.join(tmpRoot, ".samo", "spec", slug);
    mkdirSync(slugDir, { recursive: true });
    // Seed a SPEC.md with an empty architecture block so we can watch
    // iterate replace it with the rendered version of architecture.json.
    const seededSpec = [
      "# SPEC",
      "",
      "## 3. Architecture",
      "",
      "<!-- architecture:begin -->",
      "(architecture not yet specified)",
      "<!-- architecture:end -->",
      "",
      "## 4. Other",
      "",
      "body",
      "",
    ].join("\n");
    writeFileSync(path.join(slugDir, "SPEC.md"), seededSpec);
    writeFileSync(path.join(slugDir, "TLDR.md"), "# TLDR\n\n- t\n");
    writeFileSync(
      path.join(slugDir, "decisions.md"),
      "# decisions\n\n- none\n",
    );
    writeFileSync(path.join(slugDir, "changelog.md"), "# changelog\n\n- s\n");
    writeFileSync(
      path.join(slugDir, "interview.json"),
      JSON.stringify({
        slug,
        persona: "x",
        generated_at: "2026-04-21T00:00:00Z",
        questions: [],
        answers: [],
      }),
    );
    writeFileSync(
      path.join(slugDir, "context.json"),
      JSON.stringify({
        phase: "draft",
        files: [],
        risk_flags: [],
        budget: { phase: "draft", tokens_used: 0, tokens_budget: 0 },
      }),
    );
    // Seed a non-empty architecture.json so iterate re-renders a real
    // box diagram, not the placeholder.
    writeArchitecture(path.join(slugDir, "architecture.json"), {
      version: "1",
      nodes: [
        { id: "user", label: "User", kind: "external" },
        { id: "app", label: "App", kind: "component" },
      ],
      edges: [{ from: "user", to: "app", kind: "call" }],
    });
    // Switch to the spec branch so iterate can commit.
    spawnSync("git", ["-C", tmpRoot, "checkout", "-b", `samospec/${slug}`]);
    spawnSync("git", ["-C", tmpRoot, "add", ".samo"]);
    spawnSync("git", ["-C", tmpRoot, "commit", "-m", `spec(${slug}): seed`]);
    writeState(path.join(slugDir, "state.json"), {
      slug,
      phase: "review_loop",
      round_index: 0,
      version: "0.1.0",
      persona: { skill: "x", accepted: true },
      push_consent: null,
      calibration: null,
      remote_stale: false,
      coupled_fallback: false,
      head_sha: null,
      round_state: "committed",
      exit: null,
      created_at: "2026-04-21T00:00:00Z",
      updated_at: "2026-04-21T00:00:00Z",
    });
    spawnSync("git", ["-C", tmpRoot, "add", ".samo"]);
    spawnSync("git", ["-C", tmpRoot, "commit", "-m", `spec(${slug}): state`]);
    const lead = {
      ...createFakeAdapter({
        revise: {
          spec: "# SPEC\n\n## 3. Architecture\n\nRevised prose.\n",
          ready: true,
          rationale: "ok",
          usage: null,
          effort_used: "max",
        },
      }),
    };
    await runIterate({
      cwd: tmpRoot,
      slug,
      now: "2026-04-21T01:00:00Z",
      resolvers: {
        onManualEdit: () => Promise.resolve("incorporate"),
        onDegraded: () => Promise.resolve("accept"),
        onReviewerExhausted: () => Promise.resolve("abort"),
      },
      adapters: {
        lead,
        reviewerA: createFakeAdapter({}),
        reviewerB: createFakeAdapter({}),
      },
      maxRounds: 1,
      sessionStartedAtMs: 0,
      nowMs: 0,
      maxWallClockMs: 60 * 60 * 1000,
    });
    const spec = readFileSync(path.join(slugDir, "SPEC.md"), "utf8");
    expect(spec).toContain("<!-- architecture:begin -->");
    expect(spec).toContain("User");
    expect(spec).toContain("App");
    expect(spec).toContain("user → app");
    // The placeholder has been replaced.
    expect(spec).not.toContain("(architecture not yet specified)");
  });
});

describe("samospec new — architecture.json + SPEC.md block (#107)", () => {
  test("writes .samo/spec/<slug>/architecture.json parseable by the schema", async () => {
    const slug = "arch-demo";
    const result = await runNewWithArchitecture(tmpRoot, slug);
    expect(result.exitCode).toBe(0);
    const archPath = path.join(
      tmpRoot,
      ".samo",
      "spec",
      slug,
      "architecture.json",
    );
    expect(existsSync(archPath)).toBe(true);
    const raw = JSON.parse(readFileSync(archPath, "utf8")) as unknown;
    const doc = parseArchitecture(raw);
    // v0.1 of this feature starts with an empty architecture unless
    // the lead adapter contributes one. The renderer substitutes the
    // placeholder at render time; both are valid states for the JSON.
    expect(doc.version).toBe("1");
  });

  test("SPEC.md contains the sentinel-delimited architecture block", async () => {
    const slug = "arch-demo";
    await runNewWithArchitecture(tmpRoot, slug);
    const spec = readFileSync(
      path.join(tmpRoot, ".samo", "spec", slug, "SPEC.md"),
      "utf8",
    );
    expect(spec).toContain("<!-- architecture:begin -->");
    expect(spec).toContain("<!-- architecture:end -->");
    // Placeholder for a zero-node architecture.
    expect(spec).toContain("(architecture not yet specified)");
  });

  test("architecture.json is tracked in git on the first commit (#94)", async () => {
    const slug = "arch-demo";
    await runNewWithArchitecture(tmpRoot, slug);
    const lsFiles = spawnSync(
      "git",
      [
        "-C",
        tmpRoot,
        "ls-files",
        "--error-unmatch",
        `.samo/spec/${slug}/architecture.json`,
      ],
      { encoding: "utf8" },
    );
    expect(lsFiles.status).toBe(0);
  });
});
