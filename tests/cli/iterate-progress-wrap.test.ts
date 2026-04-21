// Copyright 2026 Nikolay Samokhvalov.

/**
 * Issue #101 reviewer follow-up — `wrapAdaptersForProgress` must not
 * drop the adapter's class prototype.
 *
 * The original implementation used object-spread (`{...adapters.lead,
 * revise: ...}`) to layer on the progress-aware `revise` / `critique`
 * hooks. On a real `class X implements Adapter` instance this silently
 * drops every prototype method — `vendor` (own property) survives but
 * `detect()`, `auth_status()`, `models()`, `ask()`, `supports_*` etc.
 * disappear. Today the loop only calls `revise` + `critique` so the bug
 * is latent; any future caller hitting another method would crash with
 * no compile-time warning because the wrapper still satisfies the
 * Adapter type structurally.
 *
 * The fix must preserve the class prototype AND satisfy `Adapter`
 * cleanly. These tests pin down the expectation so the object-spread
 * trap can never come back.
 */

import { describe, expect, test } from "bun:test";

import type {
  Adapter,
  AskInput,
  AskOutput,
  AuthStatus,
  CritiqueInput,
  CritiqueOutput,
  DetectResult,
  EffortLevel,
  ModelInfo,
  ReviseInput,
  ReviseOutput,
} from "../../src/adapter/types.ts";
import { wrapAdaptersForProgress } from "../../src/cli/iterate.ts";
import type { ProgressReporter } from "../../src/cli/iterate-progress.ts";
import type { State } from "../../src/state/types.ts";

class FakeClassAdapter implements Adapter {
  readonly vendor: string;

  constructor(vendor: string) {
    this.vendor = vendor;
  }

  detect(): Promise<DetectResult> {
    return Promise.resolve({ installed: true, version: "x", path: "/x" });
  }

  auth_status(): Promise<AuthStatus> {
    return Promise.resolve({ authenticated: true });
  }

  supports_structured_output(): boolean {
    return true;
  }

  supports_effort(_level: EffortLevel): boolean {
    return true;
  }

  models(): Promise<readonly ModelInfo[]> {
    return Promise.resolve([{ id: `${this.vendor}-max`, family: this.vendor }]);
  }

  ask(_input: AskInput): Promise<AskOutput> {
    return Promise.resolve({
      answer: "ok",
      usage: null,
      effort_used: "max",
    });
  }

  critique(_input: CritiqueInput): Promise<CritiqueOutput> {
    return Promise.resolve({
      findings: [],
      summary: "",
      suggested_next_version: "0.2",
      usage: null,
      effort_used: "max",
    });
  }

  revise(_input: ReviseInput): Promise<ReviseOutput> {
    return Promise.resolve({
      spec: "# SPEC\n\nrevised\n",
      ready: true,
      rationale: "[]",
      usage: null,
      effort_used: "max",
    });
  }

  /**
   * Prototype method that is NOT part of the Adapter interface — used
   * as a probe for "did the wrapper drop my prototype methods?". A
   * real adapter may add helpers like this (internal cache hooks,
   * doctor() probes, etc.) and downstream callers that cast back to
   * the concrete class must continue to see them after wrapping.
   */
  customProtoHelper(): string {
    return `custom:${this.vendor}`;
  }
}

const NOOP_PROGRESS: ProgressReporter = {
  roundStart: () => undefined,
  beginReviewer: () => ({
    complete: () => undefined,
    abort: () => undefined,
  }),
  beginLead: () => ({
    complete: () => undefined,
    abort: () => undefined,
  }),
  shutdown: () => undefined,
};

function seedState(): State {
  return {
    slug: "refunds",
    phase: "review_loop",
    round_index: 0,
    version: "0.1.0",
    persona: { skill: "refunds", accepted: true },
    push_consent: null,
    calibration: null,
    remote_stale: false,
    coupled_fallback: false,
    head_sha: null,
    round_state: "committed",
    exit: null,
    created_at: "2026-04-19T12:00:00Z",
    updated_at: "2026-04-19T12:00:00Z",
  };
}

describe("wrapAdaptersForProgress — preserves class prototype (#101)", () => {
  test("wrapped adapters still satisfy instanceof of the original class", () => {
    const lead = new FakeClassAdapter("claude");
    const revA = new FakeClassAdapter("codex");
    const revB = new FakeClassAdapter("claude");

    const wrapped = wrapAdaptersForProgress(
      { lead, reviewerA: revA, reviewerB: revB },
      seedState(),
      NOOP_PROGRESS,
    );

    expect(wrapped.lead).toBeInstanceOf(FakeClassAdapter);
    expect(wrapped.reviewerA).toBeInstanceOf(FakeClassAdapter);
    expect(wrapped.reviewerB).toBeInstanceOf(FakeClassAdapter);
  });

  test("wrapped adapters retain prototype methods (detect / models / ask)", async () => {
    const lead = new FakeClassAdapter("claude");
    const revA = new FakeClassAdapter("codex");
    const revB = new FakeClassAdapter("claude");

    const wrapped = wrapAdaptersForProgress(
      { lead, reviewerA: revA, reviewerB: revB },
      seedState(),
      NOOP_PROGRESS,
    );

    // Prototype methods must be callable on the wrapped value. The
    // object-spread implementation silently drops these because
    // prototype methods are non-enumerable own properties of the
    // prototype, not of the instance.
    expect(await wrapped.lead.detect()).toEqual({
      installed: true,
      version: "x",
      path: "/x",
    });
    expect(await wrapped.reviewerA.models()).toEqual([
      { id: "codex-max", family: "codex" },
    ]);
    expect(wrapped.reviewerB.supports_structured_output()).toBe(true);

    // Custom prototype methods must survive too so downstream code
    // that casts wrapped back to the concrete class keeps working.
    expect(
      (wrapped.lead as unknown as FakeClassAdapter).customProtoHelper(),
    ).toBe("custom:claude");
  });

  test("wrapped adapters still intercept critique/revise with progress hooks", async () => {
    const lead = new FakeClassAdapter("claude");
    const revA = new FakeClassAdapter("codex");
    const revB = new FakeClassAdapter("claude");

    const callLog: string[] = [];
    const progress: ProgressReporter = {
      roundStart: () => undefined,
      beginReviewer: (seat) => {
        callLog.push(`begin:${seat}`);
        return {
          complete: () => callLog.push(`complete:${seat}`),
          abort: () => callLog.push(`abort:${seat}`),
        };
      },
      beginLead: () => {
        callLog.push("begin:lead");
        return {
          complete: () => callLog.push("complete:lead"),
          abort: () => callLog.push("abort:lead"),
        };
      },
      shutdown: () => undefined,
    };

    const wrapped = wrapAdaptersForProgress(
      { lead, reviewerA: revA, reviewerB: revB },
      seedState(),
      progress,
    );

    const critiqueInput: CritiqueInput = {
      spec: "# SPEC\n\nseed\n",
      guidelines: "",
      opts: { effort: "max", timeout: 1_000 },
    };
    const reviseInput: ReviseInput = {
      spec: "# SPEC\n\nseed\n",
      reviews: [],
      decisions_history: [],
      opts: { effort: "max", timeout: 1_000 },
    };

    await wrapped.reviewerA.critique(critiqueInput);
    await wrapped.reviewerB.critique(critiqueInput);
    await wrapped.lead.revise(reviseInput);

    expect(callLog).toEqual([
      "begin:reviewer_a",
      "complete:reviewer_a",
      "begin:reviewer_b",
      "complete:reviewer_b",
      "begin:lead",
      "complete:lead",
    ]);
  });
});
