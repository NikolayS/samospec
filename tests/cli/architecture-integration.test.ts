// Copyright 2026 Nikolay Samokhvalov.

// SPEC §3 + Issue #107 — integration tests asserting that `samospec
// new` emits an architecture.json and a sentinel-delimited ASCII block
// in SPEC.md, and that iterate re-renders the block from architecture
// .json on each round.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { createFakeAdapter } from "../../src/adapter/fake-adapter.ts";
import type {
  Adapter,
  AskInput,
  AskOutput,
  ReviseInput,
  ReviseOutput,
} from "../../src/adapter/types.ts";
import { runIterate } from "../../src/cli/iterate.ts";
import { runNew, type ChoiceResolvers } from "../../src/cli/new.ts";
import { runInit } from "../../src/cli/init.ts";
import { writeArchitecture } from "../../src/state/architecture-store.ts";
import { parseArchitecture } from "../../src/state/architecture.ts";
import { writeState } from "../../src/state/store.ts";
import { createTempRepo, type TempRepo } from "../git/helpers/tempRepo.ts";

function askOut(answer: string): AskOutput {
  return { answer, usage: null, effort_used: "max" };
}

function personaJson(): string {
  return JSON.stringify({
    persona: 'Veteran "architecture diagram" expert',
    rationale: "matches the idea",
  });
}

function questionsJson(): string {
  return JSON.stringify({
    questions: [
      { id: "q1", text: "framework?", options: ["a", "b"] },
      { id: "q2", text: "auth?", options: ["a", "b"] },
    ],
  });
}

const SAMPLE_SPEC =
  "# arch-demo\n\n" +
  "## Goal\n\nEmit diagrams alongside specs.\n\n" +
  "## 3. Architecture\n\nInitial prose.\n\n" +
  "## 4. Other\n\n- bullet\n";

function makeLeadAdapter(): Adapter {
  const base = createFakeAdapter();
  const answers = [personaJson(), questionsJson()];
  let askCall = 0;
  return {
    ...base,
    ask: (_input: AskInput): Promise<AskOutput> => {
      const a = answers[askCall] ?? answers[answers.length - 1] ?? "";
      askCall += 1;
      return Promise.resolve(askOut(a));
    },
    revise: (_input: ReviseInput): Promise<ReviseOutput> =>
      Promise.resolve({
        spec: SAMPLE_SPEC,
        ready: false,
        rationale: "v0.1 draft",
        usage: null,
        effort_used: "max",
      }),
  };
}

function acceptResolver(): ChoiceResolvers {
  return {
    persona: () => Promise.resolve({ kind: "accept" }),
    question: (_q) => Promise.resolve({ choice: "decide for me" }),
  };
}

// ---------- fixtures ----------

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

// ---------- new ----------

describe("samospec new — architecture.json + SPEC.md block (#107)", () => {
  test("writes .samo/spec/<slug>/architecture.json parseable by the schema", async () => {
    const slug = "arch-demo";
    const result = await runNew(
      {
        cwd: tmp,
        slug,
        idea: "a CLI that emits architecture diagrams",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-21T00:00:00Z",
        noPush: true,
      },
      makeLeadAdapter(),
    );
    expect(result.exitCode).toBe(0);
    const archPath = path.join(
      tmp,
      ".samo",
      "spec",
      slug,
      "architecture.json",
    );
    expect(existsSync(archPath)).toBe(true);
    const doc = parseArchitecture(
      JSON.parse(readFileSync(archPath, "utf8")) as unknown,
    );
    expect(doc.version).toBe("1");
  });

  test("SPEC.md contains the sentinel-delimited architecture block", async () => {
    const slug = "arch-demo";
    await runNew(
      {
        cwd: tmp,
        slug,
        idea: "a CLI that emits architecture diagrams",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-21T00:00:00Z",
        noPush: true,
      },
      makeLeadAdapter(),
    );
    const spec = readFileSync(
      path.join(tmp, ".samo", "spec", slug, "SPEC.md"),
      "utf8",
    );
    expect(spec).toContain("<!-- architecture:begin -->");
    expect(spec).toContain("<!-- architecture:end -->");
    // Empty architecture => placeholder inside the sentinels.
    expect(spec).toContain("(architecture not yet specified)");
  });

  test("architecture.json is tracked in git on the first commit (#94)", async () => {
    const slug = "arch-demo";
    await runNew(
      {
        cwd: tmp,
        slug,
        idea: "a CLI that emits architecture diagrams",
        explain: false,
        resolvers: acceptResolver(),
        now: "2026-04-21T00:00:00Z",
        noPush: true,
      },
      makeLeadAdapter(),
    );
    const lsFiles = repo.run([
      "ls-files",
      "--error-unmatch",
      `.samo/spec/${slug}/architecture.json`,
    ]);
    expect(lsFiles.status).toBe(0);
  });
});

// ---------- iterate ----------

describe("samospec iterate — architecture block re-render (#107)", () => {
  test("re-renders the SPEC.md block from architecture.json each round", async () => {
    const slug = "arch-iter";
    // Minimal spec on disk so iterate can load state + spec.
    const slugDir = path.join(tmp, ".samo", "spec", slug);
    mkdirSync(slugDir, { recursive: true });
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
    writeArchitecture(path.join(slugDir, "architecture.json"), {
      version: "1",
      nodes: [
        { id: "user", label: "User", kind: "external" },
        { id: "app", label: "App", kind: "component" },
      ],
      edges: [{ from: "user", to: "app", kind: "call" }],
    });
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
    repo.run(["checkout", "-b", `samospec/${slug}`]);
    repo.run(["add", ".samo"]);
    repo.run(["commit", "-m", `spec(${slug}): seed`]);
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
      cwd: tmp,
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
    expect(spec).not.toContain("(architecture not yet specified)");
  });
});
