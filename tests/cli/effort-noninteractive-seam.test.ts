// Copyright 2026 Nikolay Samokhvalov.

// Non-interactive derivation seam for the effort prompt (samospec
// robustness pass).
//
// `resolveSeatEffortsWithPrompt` is well-tested GIVEN a `nonInteractive`
// boolean (see effort-prompt.test.ts). But the logic that COMPUTES that
// boolean from the parsed CLI flags lives in cli.ts and was previously
// inlined inside the command handlers, untested:
//
//   new:     jsonl || --yes || --accept-persona || !stdinIsTty
//   iterate:           --yes ||                     !stdinIsTty
//
// The feature spec requires the prompt be skipped under
// --interview-protocol jsonl / --yes / --accept-persona / non-TTY. A bug
// where, e.g., jsonl mode forgot to set nonInteractive would reintroduce
// the #114 readline-on-non-TTY crash and pass every other test. These
// tests pin each flag's contribution AND the deliberate `new` vs
// `iterate` asymmetry (iterate has no persona/jsonl interview surface).

import { describe, expect, test } from "bun:test";

import {
  deriveIterateNonInteractive,
  deriveNewNonInteractive,
} from "../../src/cli.ts";

const NEW_BASE = {
  yes: false,
  acceptPersona: false,
} as const;

describe("deriveNewNonInteractive — `new` prompt gating", () => {
  test("interactive TTY with no automation flag -> false (prompt allowed)", () => {
    expect(deriveNewNonInteractive({ ...NEW_BASE }, true)).toBe(false);
  });

  test("--interview-protocol jsonl -> true even on a TTY (#114 crash guard)", () => {
    expect(
      deriveNewNonInteractive(
        { ...NEW_BASE, interviewProtocol: "jsonl" },
        true,
      ),
    ).toBe(true);
  });

  test("--yes -> true even on a TTY", () => {
    expect(deriveNewNonInteractive({ ...NEW_BASE, yes: true }, true)).toBe(
      true,
    );
  });

  test("--accept-persona -> true even on a TTY", () => {
    expect(
      deriveNewNonInteractive({ ...NEW_BASE, acceptPersona: true }, true),
    ).toBe(true);
  });

  test("non-TTY stdin -> true even with no automation flag (piped/CI)", () => {
    expect(deriveNewNonInteractive({ ...NEW_BASE }, false)).toBe(true);
  });

  test("every automation flag independently forces non-interactive", () => {
    // Each flag alone (on a TTY) must be sufficient — none may be dropped.
    expect(
      deriveNewNonInteractive(
        { ...NEW_BASE, interviewProtocol: "jsonl" },
        true,
      ),
    ).toBe(true);
    expect(deriveNewNonInteractive({ ...NEW_BASE, yes: true }, true)).toBe(
      true,
    );
    expect(
      deriveNewNonInteractive({ ...NEW_BASE, acceptPersona: true }, true),
    ).toBe(true);
  });
});

describe("deriveIterateNonInteractive — `iterate` prompt gating", () => {
  test("interactive TTY with no --yes -> false (prompt allowed)", () => {
    expect(deriveIterateNonInteractive({ yes: false }, true)).toBe(false);
  });

  test("--yes -> true even on a TTY", () => {
    expect(deriveIterateNonInteractive({ yes: true }, true)).toBe(true);
  });

  test("non-TTY stdin -> true even without --yes (piped/CI)", () => {
    expect(deriveIterateNonInteractive({ yes: false }, false)).toBe(true);
  });
});

describe("new vs iterate non-interactive asymmetry is intentional", () => {
  // iterate does not parse --accept-persona or --interview-protocol; its
  // gating must NOT depend on persona/jsonl. The two derivations agree
  // only on the shared inputs (--yes, TTY). This pins the asymmetry so a
  // future copy-paste that folds persona/jsonl into iterate is caught.
  test("on a TTY, the new-only flags do NOT influence iterate's gating", () => {
    // Same shared inputs (no --yes, TTY) -> both interactive.
    expect(deriveNewNonInteractive({ ...NEW_BASE }, true)).toBe(false);
    expect(deriveIterateNonInteractive({ yes: false }, true)).toBe(false);
    // jsonl/acceptPersona flip `new` to non-interactive; iterate has no
    // such inputs, so its TTY behaviour is unchanged (still interactive).
    expect(
      deriveNewNonInteractive(
        { ...NEW_BASE, interviewProtocol: "jsonl" },
        true,
      ),
    ).toBe(true);
    expect(deriveIterateNonInteractive({ yes: false }, true)).toBe(false);
  });

  test("the two derivations agree on the shared inputs (--yes, TTY state)", () => {
    for (const yes of [true, false]) {
      for (const tty of [true, false]) {
        expect(
          deriveNewNonInteractive({ yes, acceptPersona: false }, tty),
        ).toBe(deriveIterateNonInteractive({ yes }, tty));
      }
    }
  });
});
