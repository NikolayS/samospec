// Copyright 2026 Nikolay Samokhvalov.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { discoverContext } from "../../src/context/index.ts";
import { createTempRepo, type TempRepo } from "../git/helpers/tempRepo.ts";

/**
 * SPEC §7 TDD targets called out explicitly in Issue #11:
 *
 *  - "copies a .env.staging into a temp repo and asserts it is NEVER
 *    returned by discovery"
 *  - "attempt to whitelist .env via .samospec-ignore → still excluded"
 *  - envelope spoof test lives in envelope.test.ts
 *  - blob-sha cache survival lives in gist.test.ts
 *  - 2000-line markdown truncation lives in truncate.test.ts
 *  - batched git log spawn-count invariant lives in git-meta.test.ts
 *  - context.json round-trip lives in provenance.test.ts
 */
describe("context/security — no-read cannot be overridden (SPEC §7)", () => {
  let repo: TempRepo;

  beforeEach(() => {
    repo = createTempRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  test("copying .env.staging into a temp repo — discovery NEVER returns it", () => {
    repo.write(".env.staging", "API_TOKEN=synthetic-for-tests-1234\n");
    repo.write("src/app.ts", "export const app = 1;\n");
    const result = discoverContext({
      repoPath: repo.dir,
      slug: "demo",
      phase: "draft",
      contextPaths: ["src"],
    });
    const paths = result.context.files.map((f) => f.path);
    expect(paths).not.toContain(".env.staging");
    for (const chunk of result.chunks) {
      expect(chunk).not.toContain("API_TOKEN=synthetic-for-tests");
    }
  });

  test(".samospec-ignore negation cannot un-ignore .env files", () => {
    repo.write(".samospec-ignore", "!.env\n!.env.*\n");
    repo.write(".env", "PG_URI=postgres://synthetic@localhost/demo\n");
    repo.write(".env.dev", "DEBUG=1\n");
    const result = discoverContext({
      repoPath: repo.dir,
      slug: "demo",
      phase: "draft",
      contextPaths: [],
    });
    const paths = result.context.files.map((f) => f.path);
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain(".env.dev");
    for (const chunk of result.chunks) {
      expect(chunk).not.toContain("PG_URI=postgres://synthetic");
    }
  });

  test("private-key files are never discovered", () => {
    // Synthetic PEM-looking blob; the header is a literal string, no
    // real key material.
    repo.write(
      "keys/service.pem",
      "-----BEGIN PRIVATE KEY-----\nsyntheticfortest\n-----END PRIVATE KEY-----\n",
    );
    repo.write("src/app.ts", "export const a = 1;\n");
    const result = discoverContext({
      repoPath: repo.dir,
      slug: "demo",
      phase: "draft",
      contextPaths: ["src"],
    });
    const paths = result.context.files.map((f) => f.path);
    expect(paths).not.toContain("keys/service.pem");
  });
});
