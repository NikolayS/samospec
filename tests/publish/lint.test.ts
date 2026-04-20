// Copyright 2026 Nikolay Samokhvalov.

/**
 * Tests for `src/publish/lint.ts` — the publishLint orchestrator that
 * combines extractors with repo state. Per SPEC §14: hard warnings for
 * missing-on-disk paths, soft warnings for unknown commands, ghost
 * branches, and adapter/model drift. `$PATH` is NOT consulted.
 *
 * Red-first: the module does not exist yet.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publishLint } from "../../src/publish/lint.ts";
import type { RepoState } from "../../src/publish/lint-types.ts";

interface Fixture {
  readonly dir: string;
  readonly cleanup: () => void;
  readonly write: (relPath: string, contents: string) => void;
}

function mkFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "samospec-publish-lint-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    write: (rel, contents) => {
      const full = join(dir, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, contents);
    },
  };
}

function baseRepoState(overrides: Partial<RepoState> = {}): RepoState {
  return {
    repoRoot: "/nonexistent-should-be-overridden",
    branches: [],
    protectedBranches: [],
    adapterModels: [],
    config: {},
    ...overrides,
  };
}

describe("publishLint — hard warnings: missing file paths", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = mkFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  test("HARD: spec references `src/foo/bar.ts` in a ts fence but it is missing on disk", () => {
    const spec = [
      "## Implementation",
      "",
      "```ts",
      "// see src/foo/bar.ts",
      "```",
    ].join("\n");
    const report = publishLint(spec, baseRepoState({ repoRoot: fx.dir }));
    const msgs = report.hardWarnings.map((w) => w.message);
    expect(msgs.join("\n")).toContain("src/foo/bar.ts");
    expect(report.hardWarnings.length).toBeGreaterThan(0);
    // Should carry a location with the line number.
    const finding = report.hardWarnings.find((w) =>
      w.message.includes("src/foo/bar.ts"),
    );
    expect(finding?.location?.line).toBeGreaterThan(0);
    expect(finding?.kind).toBe("missing-path");
  });

  test("no hard warning when the referenced path exists on disk", () => {
    fx.write("src/foo/bar.ts", "// exists\n");
    const spec = "See `src/foo/bar.ts` for reference.";
    const report = publishLint(spec, baseRepoState({ repoRoot: fx.dir }));
    expect(report.hardWarnings).toEqual([]);
  });

  test("excluded-path examples do NOT raise hard warnings", () => {
    const spec = [
      "Version v1.2.3 shipped.",
      "See https://github.com/foo/bar.",
      "Use e.g. a flag.",
      "Qualified foo.bar.baz and domain example.com.au appear.",
    ].join("\n");
    const report = publishLint(spec, baseRepoState({ repoRoot: fx.dir }));
    expect(report.hardWarnings).toEqual([]);
  });

  test("same missing path referenced twice yields exactly one hard warning", () => {
    const spec = [
      "`src/missing.ts` appears here.",
      "",
      "```text",
      "src/missing.ts",
      "```",
    ].join("\n");
    const report = publishLint(spec, baseRepoState({ repoRoot: fx.dir }));
    const msgs = report.hardWarnings.filter((w) =>
      w.message.includes("src/missing.ts"),
    );
    expect(msgs.length).toBe(1);
  });
});

describe("publishLint — soft warnings: unknown commands", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = mkFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  test("unknown `rm` is SOFT; default-allowlisted `samospec`/`git` are NOT warned", () => {
    const spec = [
      "```bash",
      "samospec iterate",
      "git log --oneline",
      "rm -rf /",
      "```",
    ].join("\n");
    const report = publishLint(spec, baseRepoState({ repoRoot: fx.dir }));
    const soft = report.softWarnings.filter((w) => w.kind === "unknown-command");
    const cmds = soft.map((w) => w.message);
    expect(cmds.some((m) => m.includes("rm"))).toBe(true);
    expect(cmds.some((m) => m.includes("samospec"))).toBe(false);
    expect(cmds.some((m) => m.includes("git"))).toBe(false);
  });

  test("adding `rm` to `publish_lint.allowed_commands` silences that soft warning", () => {
    const spec = ["```bash", "rm -rf /tmp/foo", "```"].join("\n");
    const report = publishLint(
      spec,
      baseRepoState({
        repoRoot: fx.dir,
        config: { publish_lint: { allowed_commands: ["rm"] } },
      }),
    );
    const soft = report.softWarnings.filter(
      (w) => w.kind === "unknown-command" && w.message.includes("rm"),
    );
    expect(soft.length).toBe(0);
  });

  test("$PATH is NOT consulted: an on-PATH binary still raises a soft warning", () => {
    // Create a fake binary in a temp PATH directory and prepend it to PATH.
    const pathDir = mkdtempSync(join(tmpdir(), "samospec-fake-path-"));
    try {
      const fakeBin = join(pathDir, "foobar");
      writeFileSync(fakeBin, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
      const originalPath = process.env["PATH"];
      process.env["PATH"] = `${pathDir}:${originalPath ?? ""}`;
      try {
        const spec = ["```bash", "foobar --run", "```"].join("\n");
        const report = publishLint(spec, baseRepoState({ repoRoot: fx.dir }));
        const foobarSoft = report.softWarnings.filter((w) =>
          w.message.includes("foobar"),
        );
        expect(foobarSoft.length).toBe(1);
        expect(foobarSoft[0]?.kind).toBe("unknown-command");
      } finally {
        if (originalPath === undefined) {
          delete process.env["PATH"];
        } else {
          process.env["PATH"] = originalPath;
        }
      }
    } finally {
      rmSync(pathDir, { recursive: true, force: true });
    }
  });

  test("commands outside bash/sh/shell fences are NOT flagged", () => {
    const spec = [
      "```ts",
      "// rm -rf /",
      "```",
      "",
      "```",
      "rm -rf /",
      "```",
    ].join("\n");
    const report = publishLint(spec, baseRepoState({ repoRoot: fx.dir }));
    const soft = report.softWarnings.filter((w) => w.kind === "unknown-command");
    expect(soft.length).toBe(0);
  });
});

describe("publishLint — soft warnings: ghost branches", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = mkFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  test("`samospec/refunds` ghost branch is SOFT when not in repoState.branches", () => {
    const spec = "The flow lives on `samospec/refunds`.";
    const report = publishLint(
      spec,
      baseRepoState({
        repoRoot: fx.dir,
        branches: ["main"],
      }),
    );
    const soft = report.softWarnings.filter((w) => w.kind === "ghost-branch");
    expect(soft.map((s) => s.message).join(" ")).toContain("samospec/refunds");
  });

  test("known branch in repoState.branches → NO warning", () => {
    const spec = "The flow lives on `samospec/refunds`.";
    const report = publishLint(
      spec,
      baseRepoState({
        repoRoot: fx.dir,
        branches: ["main", "samospec/refunds"],
      }),
    );
    const soft = report.softWarnings.filter((w) => w.kind === "ghost-branch");
    expect(soft).toEqual([]);
  });

  test("branch in `protectedBranches` list is treated as known", () => {
    const spec = "Merges on `main`.";
    const report = publishLint(
      spec,
      baseRepoState({
        repoRoot: fx.dir,
        branches: [],
        protectedBranches: ["main"],
      }),
    );
    const soft = report.softWarnings.filter(
      (w) => w.kind === "ghost-branch" && w.message.includes("main"),
    );
    expect(soft).toEqual([]);
  });

  test("path-looking refs like `src/foo.ts` are NOT reported as branches", () => {
    fx.write("src/foo.ts", "// present\n");
    const spec = "See `src/foo.ts`.";
    const report = publishLint(
      spec,
      baseRepoState({ repoRoot: fx.dir, branches: [] }),
    );
    const soft = report.softWarnings.filter((w) => w.kind === "ghost-branch");
    expect(soft).toEqual([]);
  });
});

describe("publishLint — soft warnings: adapter/model drift", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = mkFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  test("drift: spec mentions `claude-opus-4-6` but state.json has `claude-opus-4-7`", () => {
    const spec = "Lead runs on `claude-opus-4-6`.";
    const report = publishLint(
      spec,
      baseRepoState({
        repoRoot: fx.dir,
        adapterModels: ["claude-opus-4-7", "gpt-5.1-codex-max"],
      }),
    );
    const soft = report.softWarnings.filter((w) => w.kind === "adapter-drift");
    expect(soft.length).toBe(1);
    expect(soft[0]?.message).toContain("claude-opus-4-6");
  });

  test("spec model matches resolved adapters → NO drift warning", () => {
    const spec = "Lead runs on `claude-opus-4-7`.";
    const report = publishLint(
      spec,
      baseRepoState({
        repoRoot: fx.dir,
        adapterModels: ["claude-opus-4-7"],
      }),
    );
    const soft = report.softWarnings.filter((w) => w.kind === "adapter-drift");
    expect(soft).toEqual([]);
  });
});

describe("publishLint — report shape", () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = mkFixture();
  });
  afterEach(() => {
    fx.cleanup();
  });

  test("empty spec yields empty report", () => {
    const report = publishLint("", baseRepoState({ repoRoot: fx.dir }));
    expect(report).toEqual({ hardWarnings: [], softWarnings: [] });
  });

  test("whitespace-only spec yields empty report", () => {
    const report = publishLint(
      "   \n   \n\t\n",
      baseRepoState({ repoRoot: fx.dir }),
    );
    expect(report).toEqual({ hardWarnings: [], softWarnings: [] });
  });

  test("hard and soft warnings are separated and kinds are fixed", () => {
    const spec = [
      "Path: `src/does-not-exist.ts`.",
      "",
      "```bash",
      "zzzz --flag",
      "```",
    ].join("\n");
    const report = publishLint(
      spec,
      baseRepoState({ repoRoot: fx.dir, branches: [] }),
    );
    // Shape invariants: arrays + well-known kinds.
    for (const w of report.hardWarnings) {
      expect(["missing-path"]).toContain(w.kind);
      expect(typeof w.message).toBe("string");
    }
    for (const w of report.softWarnings) {
      expect([
        "unknown-command",
        "ghost-branch",
        "adapter-drift",
      ]).toContain(w.kind);
    }
    // Missing-path extracted + unknown-command `zzzz` both present.
    expect(report.hardWarnings.length).toBeGreaterThan(0);
    const softKinds = report.softWarnings.map((w) => w.kind);
    expect(softKinds).toContain("unknown-command");
  });

  test("location info present when derivable for hard warnings", () => {
    const spec = [
      "preamble line 1",
      "preamble line 2",
      "missing `src/gone.ts` reference",
    ].join("\n");
    const report = publishLint(
      spec,
      baseRepoState({ repoRoot: fx.dir, branches: [] }),
    );
    const hard = report.hardWarnings.find((w) =>
      w.message.includes("src/gone.ts"),
    );
    expect(hard?.location?.line).toBe(3);
  });
});
