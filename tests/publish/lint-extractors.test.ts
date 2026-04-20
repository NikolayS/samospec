// Copyright 2026 Nikolay Samokhvalov.

/**
 * Unit tests for `src/publish/lint-extractors.ts` — each extractor is a
 * pure function. Corpus-driven per SPEC §14 "hallucinated repo facts"
 * sub-section: inclusion rules (a)(b)(c), exclusion rules (version
 * strings, URLs, bare dotted prose), command language-tag filter, and
 * adapter/model/branch reference shapes.
 *
 * Red-first: extractors do not exist yet, so every case should fail the
 * initial run.
 */

import { describe, expect, test } from "bun:test";

import {
  extractAdapterRefs,
  extractBranchRefs,
  extractCommands,
  extractPaths,
} from "../../src/publish/lint-extractors.ts";

describe("extractPaths — inclusion rule (a): fenced code blocks", () => {
  test("plain path on its own line in a `text` fence is extracted", () => {
    const spec = [
      "Layout overview:",
      "",
      "```text",
      "src/foo.ts",
      "src/bar.ts",
      "```",
      "",
    ].join("\n");
    const paths = extractPaths(spec).map((p) => p.path);
    expect(paths).toContain("src/foo.ts");
    expect(paths).toContain("src/bar.ts");
  });

  test("path referenced inside a `ts` fence is extracted", () => {
    const spec = [
      "```ts",
      "// see src/publish/lint.ts",
      "import { publishLint } from 'src/publish/lint.ts';",
      "```",
    ].join("\n");
    const paths = extractPaths(spec).map((p) => p.path);
    expect(paths).toContain("src/publish/lint.ts");
  });

  test("records the line number of the extracted path", () => {
    const spec = ["line 1", "line 2", "```text", "src/foo.ts", "```"].join(
      "\n",
    );
    const extracted = extractPaths(spec);
    const found = extracted.find((p) => p.path === "src/foo.ts");
    expect(found).toBeDefined();
    expect(found?.line).toBe(4);
  });
});

describe("extractPaths — inclusion rule (b): backtick-wrapped strings", () => {
  test("`src/foo/bar.ts` in prose is extracted (contains `/`)", () => {
    const spec = "The module lives at `src/foo/bar.ts`.";
    const paths = extractPaths(spec).map((p) => p.path);
    expect(paths).toContain("src/foo/bar.ts");
  });

  test("`README.md` in prose is extracted (extension match)", () => {
    const spec = "See the top-level `README.md`.";
    const paths = extractPaths(spec).map((p) => p.path);
    expect(paths).toContain("README.md");
  });

  test.each([
    "file.json",
    "setup.sh",
    "lib.sql",
    "main.py",
    "lib.rs",
    "app.go",
    "config.yaml",
    "manifest.yml",
    "Cargo.toml",
    "index.js",
  ])("`%s` (extension match) is extracted", (name) => {
    const spec = `See \`${name}\`.`;
    const paths = extractPaths(spec).map((p) => p.path);
    expect(paths).toContain(name);
  });
});

describe("extractPaths — inclusion rule (c): bulleted lines under Files/Layout/Storage", () => {
  test("bulleted path under `## Files` is extracted", () => {
    const spec = [
      "## Files",
      "",
      "- `src/one.ts` — entry",
      "- `src/two.ts` — helper",
    ].join("\n");
    const paths = extractPaths(spec).map((p) => p.path);
    expect(paths).toContain("src/one.ts");
    expect(paths).toContain("src/two.ts");
  });

  test("bulleted path under `### Layout` is extracted", () => {
    const spec = ["### Layout", "", "- src/module/entry.ts"].join("\n");
    const paths = extractPaths(spec).map((p) => p.path);
    expect(paths).toContain("src/module/entry.ts");
  });

  test("bulleted path under a `Storage` suffix-insensitive header", () => {
    const spec = ["### State Storage", "", "- .samo/state.json"].join("\n");
    const paths = extractPaths(spec).map((p) => p.path);
    expect(paths).toContain(".samo/state.json");
  });

  test("header resets on next `## Heading` (bullets no longer under Files)", () => {
    const spec = [
      "## Files",
      "",
      "- `a.ts`",
      "",
      "## Some Other Section",
      "",
      "- reminder.example", // should NOT be treated as a path
    ].join("\n");
    const paths = extractPaths(spec).map((p) => p.path);
    expect(paths).toContain("a.ts");
    expect(paths).not.toContain("reminder.example");
  });
});

describe("extractPaths — exclusion rules (MUST NOT extract)", () => {
  test("bare dotted strings in prose are not paths", () => {
    const spec = [
      "We use things like e.g. defaults.",
      "Version v1.2.3 is pinned.",
      "See example.com for details.",
      "A qualified name foo.bar.baz is just prose.",
      "AU domain example.com.au also plain.",
    ].join("\n");
    const paths = extractPaths(spec).map((p) => p.path);
    expect(paths).not.toContain("e.g");
    expect(paths).not.toContain("v1.2.3");
    expect(paths).not.toContain("example.com");
    expect(paths).not.toContain("foo.bar.baz");
    expect(paths).not.toContain("example.com.au");
    expect(paths.length).toBe(0);
  });

  test("URLs inside prose are not paths", () => {
    const spec = [
      "See https://github.com/foo/bar for source.",
      "Or http://example.org/docs for docs.",
    ].join("\n");
    const paths = extractPaths(spec);
    expect(paths.length).toBe(0);
  });

  test("version-number-like strings never extracted even when backticked", () => {
    const spec = "Version `v1.2.3`, tag `0.1.0`, and `1.0` release.";
    const paths = extractPaths(spec);
    expect(paths.length).toBe(0);
  });

  test("URLs inside backticks are not paths", () => {
    const spec = "See `https://github.com/foo/bar`.";
    const paths = extractPaths(spec);
    expect(paths.length).toBe(0);
  });

  test("a bare backtick without a `/` and without a known extension is not a path", () => {
    const spec = "The `iterate` command is one word.";
    const paths = extractPaths(spec);
    expect(paths.length).toBe(0);
  });
});

describe("extractCommands — language-tag filter", () => {
  test("`bash` fenced block yields first tokens per line", () => {
    const spec = [
      "```bash",
      "samospec iterate",
      "git log --oneline",
      "rm -rf /tmp/foo",
      "```",
    ].join("\n");
    const commands = extractCommands(spec).map((c) => c.command);
    expect(commands).toEqual(["samospec", "git", "rm"]);
  });

  test("`sh` fenced block is scanned", () => {
    const spec = ["```sh", "foobar --flag", "```"].join("\n");
    const commands = extractCommands(spec).map((c) => c.command);
    expect(commands).toEqual(["foobar"]);
  });

  test("`shell` fenced block is scanned", () => {
    const spec = ["```shell", "bun test", "```"].join("\n");
    const commands = extractCommands(spec).map((c) => c.command);
    expect(commands).toEqual(["bun"]);
  });

  test("language-less fence is NOT scanned", () => {
    const spec = ["```", "foobar --flag", "```"].join("\n");
    expect(extractCommands(spec)).toEqual([]);
  });

  test("`ts` fence is NOT scanned", () => {
    const spec = ["```ts", "import foo from 'bar';", "```"].join("\n");
    expect(extractCommands(spec)).toEqual([]);
  });

  test("`js` fence is NOT scanned", () => {
    const spec = ["```js", "const x = 1;", "```"].join("\n");
    expect(extractCommands(spec)).toEqual([]);
  });

  test("blank lines, comments and prompt prefixes are skipped", () => {
    const spec = [
      "```bash",
      "",
      "# a comment",
      "$ samospec new foo",
      "git status",
      "```",
    ].join("\n");
    const commands = extractCommands(spec).map((c) => c.command);
    // We keep the first non-prompt, non-comment token.
    expect(commands).toContain("samospec");
    expect(commands).toContain("git");
    expect(commands).not.toContain("#");
    expect(commands).not.toContain("$");
  });

  test("line numbers correspond to source positions", () => {
    const spec = ["prose", "```bash", "samospec new", "```"].join("\n");
    const commands = extractCommands(spec);
    expect(commands[0]).toEqual({ command: "samospec", line: 3 });
  });
});

describe("extractBranchRefs — <word>/<slug> matches", () => {
  test("`samospec/refunds` in prose is extracted", () => {
    const spec = "Check branch `samospec/refunds` before publishing.";
    const refs = extractBranchRefs(spec).map((r) => r.branch);
    expect(refs).toContain("samospec/refunds");
  });

  test("`main` alone in prose is extracted as a branch candidate", () => {
    const spec = "Merges land on `main` after review.";
    const refs = extractBranchRefs(spec).map((r) => r.branch);
    expect(refs).toContain("main");
  });

  test("feature/xyz backticked is extracted", () => {
    const spec = "Work lives on `feature/xyz`.";
    const refs = extractBranchRefs(spec).map((r) => r.branch);
    expect(refs).toContain("feature/xyz");
  });

  test("paths are NOT re-reported as branches", () => {
    const spec = "See `src/foo.ts` for details.";
    const refs = extractBranchRefs(spec).map((r) => r.branch);
    expect(refs).not.toContain("src/foo.ts");
  });

  test("URLs are NOT extracted as branches", () => {
    const spec = "See https://github.com/foo/bar.";
    expect(extractBranchRefs(spec)).toEqual([]);
  });
});

describe("extractAdapterRefs — model / adapter name patterns", () => {
  test("claude-opus-4-7 is extracted", () => {
    const spec = "Lead runs on `claude-opus-4-7` at effort max.";
    const names = extractAdapterRefs(spec).map((a) => a.model);
    expect(names).toContain("claude-opus-4-7");
  });

  test("gpt-5.1-codex-max is extracted", () => {
    const spec = "Reviewer A uses `gpt-5.1-codex-max`.";
    const names = extractAdapterRefs(spec).map((a) => a.model);
    expect(names).toContain("gpt-5.1-codex-max");
  });

  test("claude-sonnet-4-6 and gpt-5.1-codex are extracted", () => {
    const spec = [
      "Fallback 1 `claude-sonnet-4-6`, fallback 2 `gpt-5.1-codex`.",
    ].join("\n");
    const names = extractAdapterRefs(spec).map((a) => a.model);
    expect(names).toContain("claude-sonnet-4-6");
    expect(names).toContain("gpt-5.1-codex");
  });

  test("plain prose without model-like names is empty", () => {
    const spec = "Nothing of interest here.";
    expect(extractAdapterRefs(spec)).toEqual([]);
  });
});
