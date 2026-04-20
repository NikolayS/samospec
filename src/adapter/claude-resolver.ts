// Copyright 2026 Nikolay Samokhvalov.

// SPEC §11: shared fallback-chain resolver consumed by both the lead
// ClaudeAdapter and the ClaudeReviewerBAdapter. The resolver encodes
// the Claude family fallback chain:
//
//   claude-opus-4-7 -> claude-sonnet-4-6 -> terminal
//
// The **coupled fallback** linkage (SPEC §11) is expressed by *sharing*
// one resolver instance between the lead and the Reviewer B adapters.
// When the lead hits a `model_unavailable` failure on opus and
// advances the resolver, Reviewer B consults the same resolver on its
// next spawn and lands on sonnet automatically — no duplicated state,
// no out-of-band signalling.
//
// The resolver is intentionally small and synchronous. It owns only
// the "which model am I currently pinned to" question; it does not
// spawn or probe the CLI. Callers (ClaudeAdapter, ClaudeReviewerBAdapter)
// remain the sole owners of classification — when they see a model-
// unavailable stderr pattern, they call `reportUnavailable()` and the
// resolver transitions.
//
// The `coupled_fallback` flag flips to `true` the first time the
// resolver has advanced past the pinned default. The loop layer
// (Sprint 3 #4) reads `resolver.snapshot()` at round start and writes
// it into `state.json.coupled_fallback`.

// ---------- chain ----------

const DEFAULT_CHAIN: readonly string[] = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
];

export const DEFAULT_CLAUDE_MODEL_CHAIN: readonly string[] = DEFAULT_CHAIN;

// ---------- types ----------

export interface ClaudeResolverOpts {
  /**
   * Override the default fallback chain. Tests may want a short chain.
   * The resolver treats chain[0] as the pinned default; subsequent
   * entries are fallbacks in order.
   */
  readonly chain?: readonly string[];
}

export interface ClaudeResolverSnapshot {
  readonly resolved_model_id: string;
  readonly coupled_fallback: boolean;
}

// ---------- ClaudeResolver ----------

export class ClaudeResolver {
  private readonly chain: readonly string[];
  private index: number;

  constructor(opts: ClaudeResolverOpts = {}) {
    const chain = opts.chain ?? DEFAULT_CHAIN;
    if (chain.length === 0) {
      throw new Error("ClaudeResolver: chain must contain at least one model");
    }
    this.chain = chain;
    this.index = 0;
  }

  /**
   * Currently resolved model id. Both adapter instances call this at
   * spawn-time to fetch the `--model` pin.
   */
  getCurrentModel(): string {
    const id = this.chain[this.index];
    if (id === undefined) {
      // Unreachable: index never exceeds chain.length - 1.
      throw new Error("ClaudeResolver: resolver is in an invalid state");
    }
    return id;
  }

  /**
   * Report that the given model is unavailable (from a CLI error the
   * caller classified as "model gone"). The resolver advances to the
   * next model in the chain iff the reported id is the currently
   * resolved one. Reports for stale ids are no-ops so multiple callers
   * can safely signal the same failure without racing past the chain.
   *
   * When already on the last entry in the chain, the resolver stays
   * put — there is nothing to advance to. Callers see the same model
   * id and must route the failure terminally themselves.
   */
  reportUnavailable(modelId: string): void {
    if (this.chain[this.index] !== modelId) {
      return;
    }
    if (this.index >= this.chain.length - 1) {
      return;
    }
    this.index += 1;
  }

  /**
   * State snapshot for `state.json`. `coupled_fallback: true` iff the
   * resolver has advanced past the pinned default.
   */
  snapshot(): ClaudeResolverSnapshot {
    return {
      resolved_model_id: this.getCurrentModel(),
      coupled_fallback: this.index > 0,
    };
  }
}
