// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  GhIssueAdapter,
  createFirstSprintIssues,
  formatFirstSprintDryRun,
  planFirstSprintIssues,
  type IssueCreateInput,
  type IssueTracker,
} from "../../src/implementation/first-sprint.ts";

const FIXTURE = readFileSync(
  path.join(import.meta.dir, "..", "fixtures", "implementation", "SPEC.md"),
  "utf8",
);

const SOURCE = {
  slug: "backlog-creator",
  specPath: "blueprints/backlog-creator/SPEC.md",
  sourceRef: "abc1234",
  repo: "NikolayS/samospec",
};

describe("first sprint issue planning", () => {
  test("extracts deterministic first-sprint issues from fixture SPEC.md", () => {
    const planned = planFirstSprintIssues({
      specBody: FIXTURE,
      source: SOURCE,
    });

    expect(planned.map((issue) => issue.title)).toEqual([
      "[backlog-creator] Sprint 1: Parse Team and first sprint markdown",
      "[backlog-creator] Sprint 1: Create GitHub issues through an injectable adapter",
      "[backlog-creator] Sprint 1: Add red/green TDD coverage",
    ]);
    expect(planned.map((issue) => issue.taskSlug)).toEqual([
      "parse-team-and-first-sprint-markdown",
      "create-github-issues-through-an-injectable-adapter",
      "add-red-green-tdd-coverage",
    ]);
    expect(planned[0]?.body).toContain(
      "<!-- samospec:first-sprint-task backlog-creator:parse-team-and-first-sprint-markdown -->",
    );
    expect(planned[0]?.body).toContain(
      "Source: `blueprints/backlog-creator/SPEC.md` at `abc1234`",
    );
    expect(planned[0]?.body).toContain(
      'Veteran "TypeScript CLI engineer" expert',
    );
    expect(planned[0]?.body).toContain("red/green TDD");
    expect(planned[0]?.body).toContain(
      "Post intermediate progress in issue comments",
    );
    expect(planned[0]?.body).toContain("Open a draft PR linked to this issue");
    expect(planned[0]?.body).toContain("SPEC.md#implementation-plan");
  });

  test("dry-run formats planned issues without calling the tracker", async () => {
    const tracker: IssueTracker = {
      findByMarker() {
        throw new Error("dry-run must not query existing issues");
      },
      createIssue() {
        throw new Error("dry-run must not create issues");
      },
    };

    const result = await createFirstSprintIssues({
      specBody: FIXTURE,
      source: SOURCE,
      tracker,
      dryRun: true,
    });

    expect(result.created).toEqual([]);
    expect(result.skippedDuplicates).toEqual([]);
    expect(result.planned).toHaveLength(3);
    expect(formatFirstSprintDryRun(result.planned)).toContain(
      "- [backlog-creator] Sprint 1: Parse Team and first sprint markdown",
    );
  });

  test("posting skips existing samospec task markers on retry", async () => {
    const created: IssueCreateInput[] = [];
    const existingMarker =
      "samospec:first-sprint-task backlog-creator:parse-team-and-first-sprint-markdown";
    const tracker: IssueTracker = {
      findByMarker(marker) {
        if (marker === existingMarker) {
          return Promise.resolve({
            number: 11,
            url: "https://github.com/NikolayS/samospec/issues/11",
          });
        }
        return Promise.resolve(null);
      },
      createIssue(input) {
        created.push(input);
        return Promise.resolve({
          number: 20 + created.length,
          url: `https://github.com/NikolayS/samospec/issues/${String(
            20 + created.length,
          )}`,
        });
      },
    };

    const result = await createFirstSprintIssues({
      specBody: FIXTURE,
      source: SOURCE,
      tracker,
      dryRun: false,
    });

    expect(result.skippedDuplicates).toEqual([
      {
        marker: existingMarker,
        number: 11,
        url: "https://github.com/NikolayS/samospec/issues/11",
      },
    ]);
    expect(created.map((issue) => issue.title)).toEqual([
      "[backlog-creator] Sprint 1: Create GitHub issues through an injectable adapter",
      "[backlog-creator] Sprint 1: Add red/green TDD coverage",
    ]);
    expect(result.created.map((issue) => issue.url)).toEqual([
      "https://github.com/NikolayS/samospec/issues/21",
      "https://github.com/NikolayS/samospec/issues/22",
    ]);
  });
});

describe("GhIssueAdapter", () => {
  test("uses injected gh runner for marker lookup and issue creation", async () => {
    const calls: readonly string[][] = [];
    const mutableCalls: string[][] = calls as string[][];
    const adapter = new GhIssueAdapter({
      repo: "NikolayS/samospec",
      run: (argv) => {
        mutableCalls.push([...argv]);
        if (argv[0] === "issue" && argv[1] === "list") {
          return {
            status: 0,
            stdout:
              '[{"number":42,"url":"https://github.com/NikolayS/samospec/issues/42"}]',
            stderr: "",
          };
        }
        if (argv[0] === "issue" && argv[1] === "create") {
          return {
            status: 0,
            stdout: "https://github.com/NikolayS/samospec/issues/43\n",
            stderr: "",
          };
        }
        return { status: 1, stdout: "", stderr: "unexpected argv" };
      },
    });

    const found = await adapter.findByMarker(
      "samospec:first-sprint-task backlog-creator:x",
    );
    const created = await adapter.createIssue({
      title: "[backlog-creator] Sprint 1: x",
      body: "body",
      labels: ["samospec", "first-sprint"],
    });

    expect(found).toEqual({
      number: 42,
      url: "https://github.com/NikolayS/samospec/issues/42",
    });
    expect(created).toEqual({
      number: 43,
      url: "https://github.com/NikolayS/samospec/issues/43",
    });
    expect(mutableCalls[0]).toEqual([
      "issue",
      "list",
      "--repo",
      "NikolayS/samospec",
      "--search",
      "samospec:first-sprint-task backlog-creator:x",
      "--json",
      "number,url",
      "--state",
      "all",
      "--limit",
      "1",
    ]);
    expect(mutableCalls[1]).toEqual([
      "issue",
      "create",
      "--repo",
      "NikolayS/samospec",
      "--title",
      "[backlog-creator] Sprint 1: x",
      "--body",
      "body",
      "--label",
      "samospec,first-sprint",
    ]);
  });
});
