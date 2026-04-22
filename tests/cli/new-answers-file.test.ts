// Copyright 2026 Nikolay Samokhvalov.

// Issue #114 — `samospec new --answers-file <path>` loads the 5
// interview answers from a JSON file:
//   { "answers": ["...", "...", "...", "...", "..."] }
// length must be 5; fewer/more is exit 1.
// Malformed JSON is exit 1 with a line number where possible.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadAnswersFile,
  type LoadAnswersResult,
} from "../../src/cli/non-interactive.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-answers-file-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeFile(name: string, body: string): string {
  const p = path.join(tmp, name);
  writeFileSync(p, body, "utf8");
  return p;
}

function expectOk(
  r: LoadAnswersResult,
): asserts r is { readonly ok: true; readonly answers: readonly string[] } {
  if (!r.ok) {
    throw new Error(`expected ok, got: ${r.error}`);
  }
}

function expectErr(
  r: LoadAnswersResult,
): asserts r is { readonly ok: false; readonly error: string } {
  if (r.ok) {
    throw new Error("expected error, got ok");
  }
}

describe("loadAnswersFile (#114)", () => {
  test("valid 5-element answers array -> ok", () => {
    const p = writeFile(
      "good.json",
      JSON.stringify({ answers: ["a", "b", "c", "d", "e"] }),
    );
    const r = loadAnswersFile(p);
    expectOk(r);
    expect(r.answers).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("missing file -> error names the path", () => {
    const missing = path.join(tmp, "does-not-exist.json");
    const r = loadAnswersFile(missing);
    expectErr(r);
    expect(r.error).toContain(missing);
  });

  test("malformed JSON -> error mentions line number", () => {
    // One broken char on line 2 — line numbers start at 1.
    const p = writeFile("bad.json", '{\n  "answers": [\n    "a",\n    b\n]}\n');
    const r = loadAnswersFile(p);
    expectErr(r);
    expect(r.error.toLowerCase()).toContain("line");
  });

  test("wrong length (4) -> exit-1-shaped error names count", () => {
    const p = writeFile(
      "four.json",
      JSON.stringify({ answers: ["a", "b", "c", "d"] }),
    );
    const r = loadAnswersFile(p);
    expectErr(r);
    expect(r.error).toContain("5");
  });

  test("wrong length (6) -> exit-1-shaped error names count", () => {
    const p = writeFile(
      "six.json",
      JSON.stringify({ answers: ["a", "b", "c", "d", "e", "f"] }),
    );
    const r = loadAnswersFile(p);
    expectErr(r);
    expect(r.error).toContain("5");
  });

  test("missing answers key -> error", () => {
    const p = writeFile("noans.json", JSON.stringify({ foo: "bar" }));
    const r = loadAnswersFile(p);
    expectErr(r);
    expect(r.error.toLowerCase()).toContain("answers");
  });

  test("answers not an array -> error", () => {
    const p = writeFile("notarr.json", JSON.stringify({ answers: "x" }));
    const r = loadAnswersFile(p);
    expectErr(r);
    expect(r.error.toLowerCase()).toContain("answers");
  });

  test("non-string element -> error", () => {
    const p = writeFile(
      "notstr.json",
      JSON.stringify({ answers: ["a", "b", "c", 4, "e"] }),
    );
    const r = loadAnswersFile(p);
    expectErr(r);
  });
});
