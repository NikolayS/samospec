// Copyright 2026 Nikolay Samokhvalov.

/**
 * Regression guard. The git layer must NEVER invoke dangerous git flags:
 *   --force  / -f on push / --force-with-lease
 *   +refspec (the leading-plus force-push syntax)
 *   --no-verify (skips commit hooks)
 *   --amend (mutates the prior commit)
 *
 * This test greps all git-layer sources for those literal tokens. Any hit
 * fails CI. Future engineers who need one of these for a non-git-layer
 * purpose must place the flag OUTSIDE `src/git/`.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const ROOT = join(import.meta.dir, "..", "..", "src", "git");

const FORBIDDEN_TOKENS = [
  "--force",
  "--force-with-lease",
  "--no-verify",
  "--amend",
  // '+refspec' as a push refspec: a plus-sign immediately before a refspec.
  // The most searchable literal form that appears in real code is a push
  // invocation with "+refs/" or "+HEAD". Match on the literal "+refs/"
  // substring which cannot appear innocently in string literals.
  "+refs/",
];

describe("git-layer safety: forbidden flag regression", () => {
  const files = walk(ROOT).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );

  test("src/git contains at least one source file", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(FORBIDDEN_TOKENS)(
    "no git-layer source file contains the forbidden token '%s'",
    (token) => {
      const hits: string[] = [];
      for (const f of files) {
        const text = readFileSync(f, "utf8");
        if (text.includes(token)) {
          // Strip documentation-only mentions inside // comments or JSDoc
          // blocks. Any real code reference to these tokens is disallowed.
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? "";
            if (!line.includes(token)) continue;
            const stripped = line.trim();
            const isLineComment = stripped.startsWith("//");
            const isBlockComment =
              stripped.startsWith("*") || stripped.startsWith("/*");
            if (isLineComment || isBlockComment) continue;
            hits.push(`${f}:${String(i + 1)}: ${stripped}`);
          }
        }
      }
      expect(hits).toEqual([]);
    },
  );
});
