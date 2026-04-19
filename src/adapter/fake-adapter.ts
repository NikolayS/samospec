// Copyright 2026 Nikolay Samokhvalov.

// Reference in-memory adapter used for contract tests and scaffolding
// (Sprint 2 replaces with real Claude / Codex adapters). The fake
// adapter is scripted through a shared `FakeAdapterProgram` so the
// contract-test helper can drive every branch of the interface
// deterministically, without spawning subprocesses.

import {
  type Adapter,
  type AskInput,
  type AskOutput,
  type AuthStatus,
  type CritiqueInput,
  type CritiqueOutput,
  type DetectResult,
  type EffortLevel,
  type ModelInfo,
  type ReviseInput,
  type ReviseOutput,
  AskInputSchema,
  AskOutputSchema,
  AuthStatusSchema,
  CritiqueInputSchema,
  CritiqueOutputSchema,
  DetectResultSchema,
  ReviseInputSchema,
  ReviseOutputSchema,
} from "./types.ts";

export interface FakeAdapterProgram {
  readonly detect: DetectResult;
  readonly auth: AuthStatus;
  readonly supports_structured_output: boolean;
  readonly supports_effort: ReadonlySet<EffortLevel>;
  readonly models: readonly ModelInfo[];
  readonly ask: AskOutput;
  readonly critique: CritiqueOutput;
  readonly revise: ReviseOutput;
}

const DEFAULT_DETECT: DetectResult = {
  installed: true,
  version: "fake-1.0.0",
  path: "/usr/bin/fake",
};

const DEFAULT_AUTH: AuthStatus = {
  authenticated: true,
  account: "fake@example.com",
  subscription_auth: true,
};

const DEFAULT_MODELS: readonly ModelInfo[] = [
  { id: "fake-max", family: "fake" },
];

const DEFAULT_ASK: AskOutput = {
  answer: "fake answer",
  usage: null,
  effort_used: "max",
};

const DEFAULT_CRITIQUE: CritiqueOutput = {
  findings: [
    {
      category: "ambiguity",
      text: "'significant' — how significant?",
      severity: "minor",
    },
  ],
  summary: "one ambiguity",
  suggested_next_version: "0.1.1",
  usage: null,
  effort_used: "max",
};

const DEFAULT_REVISE: ReviseOutput = {
  spec: "# SPEC\n\nrevised.",
  ready: false,
  rationale: "needs another round",
  usage: null,
  effort_used: "max",
};

const DEFAULT_PROGRAM: FakeAdapterProgram = {
  detect: DEFAULT_DETECT,
  auth: DEFAULT_AUTH,
  supports_structured_output: true,
  supports_effort: new Set<EffortLevel>([
    "max",
    "high",
    "medium",
    "low",
    "off",
  ]),
  models: DEFAULT_MODELS,
  ask: DEFAULT_ASK,
  critique: DEFAULT_CRITIQUE,
  revise: DEFAULT_REVISE,
};

export function createFakeAdapter(
  overrides: Partial<FakeAdapterProgram> = {},
): Adapter {
  const program: FakeAdapterProgram = {
    ...DEFAULT_PROGRAM,
    ...overrides,
  };

  const vendor = "fake";

  return {
    vendor,
    detect: () => Promise.resolve(DetectResultSchema.parse(program.detect)),
    auth_status: () => Promise.resolve(AuthStatusSchema.parse(program.auth)),
    supports_structured_output: () => program.supports_structured_output,
    supports_effort: (level: EffortLevel) => program.supports_effort.has(level),
    models: () => Promise.resolve(program.models),
    ask: (input: AskInput) => {
      AskInputSchema.parse(input);
      return Promise.resolve(AskOutputSchema.parse(program.ask));
    },
    critique: (input: CritiqueInput) => {
      CritiqueInputSchema.parse(input);
      return Promise.resolve(CritiqueOutputSchema.parse(program.critique));
    },
    revise: (input: ReviseInput) => {
      ReviseInputSchema.parse(input);
      return Promise.resolve(ReviseOutputSchema.parse(program.revise));
    },
  };
}
