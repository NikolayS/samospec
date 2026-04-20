// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §5 Phase 7 + §10 — PR opening with `gh`/`glab` preference and
 * compare-URL fallback.
 *
 *   - `gh` preferred over `glab` when both authenticated.
 *   - `glab` used when only glab is authenticated.
 *   - Neither authenticated → returns compare URL derived from remote URL.
 *   - The body is passed via stdin-equivalent `--body-file` to avoid argv
 *     overflow on large PR bodies.
 *   - Title = `spec(<slug>): publish v<version>` (matches SPEC §8 grammar).
 */

import { describe, expect, test } from "bun:test";

import { buildCompareUrl, openPullRequest } from "../../src/publish/pr.ts";

function fakeRunner(name: string, outputs: string[]) {
  return (argv: readonly string[]) => {
    outputs.push(`${name} ${argv.join(" ")}`);
    return { status: 0, stdout: "", stderr: "" };
  };
}

describe("buildCompareUrl", () => {
  test("derives an https compare URL from an ssh GitHub remote", () => {
    expect(
      buildCompareUrl({
        remoteUrl: "git@github.com:NikolayS/samospec.git",
        defaultBranch: "main",
        branch: "samospec/refunds",
      }),
    ).toBe("https://github.com/NikolayS/samospec/compare/main...samospec/refunds");
  });

  test("derives a compare URL from an https GitHub remote (strips .git)", () => {
    expect(
      buildCompareUrl({
        remoteUrl: "https://github.com/NikolayS/samospec.git",
        defaultBranch: "main",
        branch: "samospec/refunds",
      }),
    ).toBe("https://github.com/NikolayS/samospec/compare/main...samospec/refunds");
  });

  test("derives a merge_requests/new URL for GitLab remotes", () => {
    expect(
      buildCompareUrl({
        remoteUrl: "git@gitlab.com:group/project.git",
        defaultBranch: "main",
        branch: "samospec/refunds",
      }),
    ).toBe(
      "https://gitlab.com/group/project/-/merge_requests/new" +
        "?merge_request[source_branch]=samospec/refunds" +
        "&merge_request[target_branch]=main",
    );
  });

  test("returns null for an unrecognized remote URL", () => {
    expect(
      buildCompareUrl({
        remoteUrl: "ssh://git@bitbucket.org/team/repo.git",
        defaultBranch: "main",
        branch: "samospec/refunds",
      }),
    ).toBe(null);
  });
});

describe("openPullRequest", () => {
  test("prefers gh when both gh and glab are authenticated", () => {
    const calls: string[] = [];
    const result = openPullRequest({
      capability: { available: true, tool: "gh" },
      title: "spec(refunds): publish v0.2",
      bodyFile: "/tmp/body.md",
      branch: "samospec/refunds",
      defaultBranch: "main",
      remoteUrl: "git@github.com:NikolayS/samospec.git",
      gh: fakeRunner("gh", calls),
      glab: fakeRunner("glab", calls),
    });
    expect(result.kind).toBe("opened");
    expect(result.tool).toBe("gh");
    expect(calls.some((c) => c.startsWith("gh pr create"))).toBe(true);
    expect(calls.some((c) => c.startsWith("glab"))).toBe(false);
  });

  test("uses glab when only glab is authenticated", () => {
    const calls: string[] = [];
    const result = openPullRequest({
      capability: { available: true, tool: "glab" },
      title: "spec(refunds): publish v0.2",
      bodyFile: "/tmp/body.md",
      branch: "samospec/refunds",
      defaultBranch: "main",
      remoteUrl: "git@gitlab.com:group/project.git",
      gh: fakeRunner("gh", calls),
      glab: fakeRunner("glab", calls),
    });
    expect(result.kind).toBe("opened");
    expect(result.tool).toBe("glab");
    expect(calls.some((c) => c.startsWith("glab mr create"))).toBe(true);
  });

  test("falls back to compare URL when neither is authenticated", () => {
    const calls: string[] = [];
    const result = openPullRequest({
      capability: { available: false },
      title: "spec(refunds): publish v0.2",
      bodyFile: "/tmp/body.md",
      branch: "samospec/refunds",
      defaultBranch: "main",
      remoteUrl: "git@github.com:NikolayS/samospec.git",
      gh: fakeRunner("gh", calls),
      glab: fakeRunner("glab", calls),
    });
    expect(result.kind).toBe("compare-url");
    expect(result.url).toBe(
      "https://github.com/NikolayS/samospec/compare/main...samospec/refunds",
    );
    expect(calls.length).toBe(0);
  });

  test("passes --title and --body-file to gh pr create", () => {
    const calls: string[] = [];
    openPullRequest({
      capability: { available: true, tool: "gh" },
      title: "spec(refunds): publish v0.2",
      bodyFile: "/tmp/body.md",
      branch: "samospec/refunds",
      defaultBranch: "main",
      remoteUrl: "git@github.com:NikolayS/samospec.git",
      gh: fakeRunner("gh", calls),
      glab: fakeRunner("glab", calls),
    });
    const invocation = calls.find((c) => c.startsWith("gh pr create"));
    expect(invocation).toBeDefined();
    expect(invocation).toContain("--title spec(refunds): publish v0.2");
    expect(invocation).toContain("--body-file /tmp/body.md");
    expect(invocation).toContain("--base main");
    expect(invocation).toContain("--head samospec/refunds");
  });

  test("passes --title and --description to glab mr create", () => {
    const calls: string[] = [];
    openPullRequest({
      capability: { available: true, tool: "glab" },
      title: "spec(refunds): publish v0.2",
      bodyFile: "/tmp/body.md",
      branch: "samospec/refunds",
      defaultBranch: "main",
      remoteUrl: "git@gitlab.com:group/project.git",
      gh: fakeRunner("gh", calls),
      glab: fakeRunner("glab", calls),
    });
    const invocation = calls.find((c) => c.startsWith("glab mr create"));
    expect(invocation).toBeDefined();
    expect(invocation).toContain("--title");
    // glab uses --description with a file via `-F`-style or inline; the
    // helper exposes whichever variant it picked via the call log. We
    // only assert the body file path appears somewhere in the argv.
    expect(invocation).toContain("/tmp/body.md");
  });

  test("returns 'failed' kind when the chosen tool exits non-zero", () => {
    const result = openPullRequest({
      capability: { available: true, tool: "gh" },
      title: "spec(refunds): publish v0.2",
      bodyFile: "/tmp/body.md",
      branch: "samospec/refunds",
      defaultBranch: "main",
      remoteUrl: "git@github.com:NikolayS/samospec.git",
      gh: () => ({ status: 1, stdout: "", stderr: "gh: not authenticated" }),
      glab: () => ({ status: 0, stdout: "", stderr: "" }),
    });
    expect(result.kind).toBe("failed");
  });
});
