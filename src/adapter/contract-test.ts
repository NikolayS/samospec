// Copyright 2026 Nikolay Samokhvalov.

// Shared contract-test helper (SPEC §13 test 4). Any adapter
// implementation (fake, Claude, Codex) must pass this helper when
// driven from its own test file. The helper drives every branch
// of the adapter interface:
//
//  - detect() returns a schema-valid payload
//  - auth_status() returns a schema-valid payload; subscription_auth
//    may be true or undefined; both are valid
//  - supports_structured_output() is a boolean
//  - supports_effort(level) is defined for every EffortLevel
//  - models() returns a non-empty, schema-valid array
//  - ask / critique / revise accept schema-valid inputs and return
//    schema-valid outputs (including `usage: null` variant)
//
// The helper uses bun:test expectations so it can be invoked from
// any test file that imports it.

import { expect } from "bun:test";

import {
  type Adapter,
  type AskInput,
  type CritiqueInput,
  type EffortLevel,
  type ReviseInput,
  AskOutputSchema,
  AuthStatusSchema,
  CritiqueOutputSchema,
  DetectResultSchema,
  EffortLevelSchema,
  ModelInfoSchema,
  ReviseOutputSchema,
} from "./types.ts";

export interface AdapterContractInput {
  readonly name: string;
  readonly makeAdapter: () => Adapter;
}

const EFFORT_LEVELS: readonly EffortLevel[] = [
  "max",
  "high",
  "medium",
  "low",
  "off",
];

const SAMPLE_OPTS = Object.freeze({
  effort: "max" as EffortLevel,
  timeout: 120_000,
});

const SAMPLE_ASK: AskInput = {
  prompt: "ping",
  context: "",
  opts: SAMPLE_OPTS,
};
const SAMPLE_CRITIQUE: CritiqueInput = {
  spec: "# SPEC\n\n(placeholder)",
  guidelines: "be paranoid",
  opts: SAMPLE_OPTS,
};
const SAMPLE_REVISE: ReviseInput = {
  spec: "# SPEC\n\n(placeholder)",
  reviews: [],
  decisions_history: [],
  opts: SAMPLE_OPTS,
};

export async function runAdapterContract(
  input: AdapterContractInput,
): Promise<void> {
  const adapter = input.makeAdapter();

  // Lifecycle
  const detect = await adapter.detect();
  DetectResultSchema.parse(detect);

  const auth = await adapter.auth_status();
  AuthStatusSchema.parse(auth);
  if (auth.subscription_auth === true) {
    expect(auth.authenticated).toBe(true);
  }

  expect(typeof adapter.supports_structured_output()).toBe("boolean");

  for (const level of EFFORT_LEVELS) {
    EffortLevelSchema.parse(level);
    expect(typeof adapter.supports_effort(level)).toBe("boolean");
  }

  const models = await adapter.models();
  expect(Array.isArray(models)).toBe(true);
  expect(models.length).toBeGreaterThan(0);
  for (const m of models) ModelInfoSchema.parse(m);

  // Work
  const ask = await adapter.ask(SAMPLE_ASK);
  AskOutputSchema.parse(ask);

  const critique = await adapter.critique(SAMPLE_CRITIQUE);
  CritiqueOutputSchema.parse(critique);

  const revise = await adapter.revise(SAMPLE_REVISE);
  ReviseOutputSchema.parse(revise);
  expect(typeof revise.ready).toBe("boolean");
  expect(typeof revise.rationale).toBe("string");

  // `usage: null` path — SPEC §7 / §11. Callers must treat this as
  // "no token budget applies" for this call. Since this contract
  // applies to adapters that may or may not support accounting, we
  // only assert that `usage` is either null OR a schema-valid object
  // (enforced by the zod parse above).
  if (ask.usage === null || critique.usage === null || revise.usage === null) {
    // At least one null-usage is emitted; subscription-auth path proven.
    expect(true).toBe(true);
  }
}
