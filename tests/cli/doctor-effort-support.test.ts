// Copyright 2026 Nikolay Samokhvalov.

// FIX 5 (samospec #180): samospec appends `--effort` to EVERY claude work
// call. A claude CLI older than the --effort minimum (v2.1.0) rejects the
// flag and every call fails. `samospec doctor` must WARN (not FAIL) when
// the installed claude predates --effort, naming the minimum version.

import { describe, expect, test } from "bun:test";

import type { Adapter, DetectResult } from "../../src/adapter/types.ts";
import { CLAUDE_MIN_EFFORT_VERSION } from "../../src/adapter/claude.ts";
import { checkEffortSupport } from "../../src/cli/doctor-checks/effort-support.ts";
import { CheckStatus } from "../../src/cli/doctor-format.ts";

function fakeAdapter(vendor: string, detect: DetectResult): Adapter {
  return {
    vendor,
    detect: () => Promise.resolve(detect),
    auth_status: () => Promise.resolve({ authenticated: true }),
    supports_structured_output: () => true,
    supports_effort: () => true,
    models: () => Promise.resolve([{ id: "x", family: vendor }]),
    ask: () => Promise.reject(new Error("unused")),
    structuredAsk: () => Promise.reject(new Error("unused")),
    critique: () => Promise.reject(new Error("unused")),
    revise: () => Promise.reject(new Error("unused")),
  };
}

const installed = (version: string): DetectResult => ({
  installed: true,
  version,
  path: "/usr/local/bin/claude",
});

describe("checkEffortSupport (FIX 5)", () => {
  test("WARNs when the installed claude predates --effort (v2.0.0 < v2.1.0)", async () => {
    const res = await checkEffortSupport({
      adapters: [
        {
          label: "lead (claude)",
          adapter: fakeAdapter("claude", installed("2.0.0")),
        },
      ],
    });
    expect(res.status).toBe(CheckStatus.Warn);
    expect(res.message).toContain("--effort");
    expect(res.message).toContain(CLAUDE_MIN_EFFORT_VERSION);
  });

  test("OK when the installed claude supports --effort (v2.1.156 >= v2.1.0)", async () => {
    const res = await checkEffortSupport({
      adapters: [
        {
          label: "lead (claude)",
          adapter: fakeAdapter("claude", installed("2.1.156")),
        },
      ],
    });
    expect(res.status).toBe(CheckStatus.Ok);
  });

  test("OK at exactly the minimum version", async () => {
    const res = await checkEffortSupport({
      adapters: [
        {
          label: "lead (claude)",
          adapter: fakeAdapter("claude", installed(CLAUDE_MIN_EFFORT_VERSION)),
        },
      ],
    });
    expect(res.status).toBe(CheckStatus.Ok);
  });

  test("never FAILs — only WARN/OK (a missing flag must not block doctor)", async () => {
    const res = await checkEffortSupport({
      adapters: [
        {
          label: "lead (claude)",
          adapter: fakeAdapter("claude", installed("1.0.0")),
        },
      ],
    });
    expect(res.status).not.toBe(CheckStatus.Fail);
  });

  test("skips non-claude adapters", async () => {
    const res = await checkEffortSupport({
      adapters: [
        {
          label: "reviewer_a (codex)",
          adapter: fakeAdapter("codex", installed("1.0.0")),
        },
      ],
    });
    expect(res.status).toBe(CheckStatus.Ok);
    expect(res.message).toContain("not checked");
  });

  test("unknown / not-installed versions do not cry wolf", async () => {
    const res = await checkEffortSupport({
      adapters: [
        {
          label: "lead (claude)",
          adapter: fakeAdapter("claude", {
            installed: true,
            version: "unknown",
            path: "/x",
          }),
        },
        {
          label: "reviewer_b (claude)",
          adapter: fakeAdapter("claude", { installed: false }),
        },
      ],
    });
    expect(res.status).toBe(CheckStatus.Ok);
  });
});
