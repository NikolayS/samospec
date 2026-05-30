// Copyright 2026 Nikolay Samokhvalov.

// Config-driven adapter construction (samospec robustness pass).
//
// Before this module, every adapter call-site in the CLI built adapters
// with their hardcoded pinned defaults (`new ClaudeAdapter()`,
// `new CodexAdapter()`) and a fresh `ClaudeResolver` with the built-in
// chain. That meant editing `adapters.<role>.model_id` /
// `adapters.<role>.fallback_chain` in `.samo/config.json` did NOTHING —
// the config was parsed for budget/paths but never threaded into the
// adapters themselves.
//
// This module reads `adapters.{lead,reviewer_a,reviewer_b}` from
// `.samo/config.json` and constructs the lead / reviewer-A / reviewer-B
// adapters (plus the shared Claude resolver for the lead + reviewer-B
// coupled fallback) from the configured `model_id` and `fallback_chain`.
// When the config is absent or a field is missing/malformed, it falls
// back to the adapter's own pinned defaults so nothing regresses.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { ClaudeAdapter } from "./claude.ts";
import { ClaudeReviewerAAdapter } from "./claude-reviewer-a.ts";
import { ClaudeReviewerBAdapter } from "./claude-reviewer-b.ts";
import { ClaudeResolver } from "./claude-resolver.ts";
import { CodexAdapter } from "./codex.ts";
import type { Adapter, ModelInfo } from "./types.ts";

/**
 * Per-seat adapter vendor selector, read from
 * `adapters.<seat>.adapter` in `.samo/config.json`. A seat may be filled
 * by either the Claude CLI or the Codex CLI. Absent / unrecognized
 * values fall back to each seat's pinned default vendor (lead → claude,
 * reviewer_a → codex, reviewer_b → claude), so the field is fully
 * back-compatible.
 */
export type AdapterVendor = "claude" | "codex";

const ADAPTER_VENDORS: ReadonlySet<string> = new Set(["claude", "codex"]);

/**
 * Chain sentinels that are NOT real model ids and must be stripped
 * before a chain is handed to an adapter / resolver. `terminal` marks
 * the end of a fallback chain in `.samo/config.json`; the codex adapter
 * separately appends its own account-default tier, so we drop both.
 */
const NON_MODEL_CHAIN_ENTRIES: ReadonlySet<string> = new Set([
  "terminal",
  "__account_default__",
]);

/** One adapter role's pinned config, as read from `.samo/config.json`. */
export interface AdapterRoleConfig {
  /**
   * Which CLI vendor fills this seat. Absent (or malformed) keeps the
   * seat's pinned-default vendor, so existing configs are unchanged.
   */
  readonly adapter?: AdapterVendor;
  readonly model_id?: string;
  readonly fallback_chain?: readonly string[];
}

export interface AdaptersConfig {
  readonly lead?: AdapterRoleConfig;
  readonly reviewer_a?: AdapterRoleConfig;
  readonly reviewer_b?: AdapterRoleConfig;
}

/**
 * Read `adapters` from `.samo/config.json` under `cwd`. Best-effort:
 * any missing file / parse error / wrong shape yields `{}` so callers
 * cleanly fall back to pinned defaults. Only the fields this module
 * cares about (`model_id`, `fallback_chain`) are validated; everything
 * else is ignored.
 */
export function readAdaptersConfig(cwd: string): AdaptersConfig {
  try {
    const configPath = path.join(cwd, ".samo", "config.json");
    if (!existsSync(configPath)) return {};
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const adapters = (parsed as Record<string, unknown>)["adapters"];
    if (typeof adapters !== "object" || adapters === null) return {};
    const rec = adapters as Record<string, unknown>;
    return {
      ...roleEntry("lead", rec),
      ...roleEntry("reviewer_a", rec),
      ...roleEntry("reviewer_b", rec),
    };
  } catch {
    return {};
  }
}

function roleEntry(
  role: keyof AdaptersConfig,
  rec: Record<string, unknown>,
): Partial<AdaptersConfig> {
  const raw = rec[role];
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const adapterRaw = r["adapter"];
  const adapter =
    typeof adapterRaw === "string" && ADAPTER_VENDORS.has(adapterRaw)
      ? (adapterRaw as AdapterVendor)
      : undefined;
  const modelId = typeof r["model_id"] === "string" ? r["model_id"] : undefined;
  const chainRaw = r["fallback_chain"];
  const chain =
    Array.isArray(chainRaw) && chainRaw.every((x) => typeof x === "string")
      ? (chainRaw as readonly string[])
      : undefined;
  if (adapter === undefined && modelId === undefined && chain === undefined) {
    return {};
  }
  return {
    [role]: {
      ...(adapter !== undefined ? { adapter } : {}),
      ...(modelId !== undefined ? { model_id: modelId } : {}),
      ...(chain !== undefined ? { fallback_chain: chain } : {}),
    },
  };
}

/**
 * Build the ordered model-id chain for a role: the pinned `model_id`
 * first, followed by every `fallback_chain` entry that is a real model
 * (sentinels stripped, the pin de-duplicated). Returns `undefined` when
 * the config supplies nothing, so the caller keeps the adapter's pinned
 * default chain.
 */
export function resolveChain(
  cfg: AdapterRoleConfig | undefined,
): string[] | undefined {
  if (cfg === undefined) return undefined;
  const out: string[] = [];
  const push = (id: string): void => {
    if (NON_MODEL_CHAIN_ENTRIES.has(id)) return;
    if (!out.includes(id)) out.push(id);
  };
  if (cfg.model_id !== undefined) push(cfg.model_id);
  for (const id of cfg.fallback_chain ?? []) push(id);
  return out.length > 0 ? out : undefined;
}

function toModelInfo(chain: readonly string[], family: string): ModelInfo[] {
  return chain.map((id) => ({ id, family }));
}

/**
 * Build a shared {@link ClaudeResolver} from the lead's configured
 * chain (the lead and reviewer-B share one resolver to express SPEC §11
 * coupled fallback). When the config supplies no usable chain, returns
 * a default resolver (pinned built-in chain).
 */
export function buildClaudeResolver(cfg: AdaptersConfig): ClaudeResolver {
  const chain = resolveChain(cfg.lead);
  return chain !== undefined
    ? new ClaudeResolver({ chain })
    : new ClaudeResolver();
}

/**
 * The lead adapter, config-pinned. Used by `samospec new` / `resume` /
 * `brief` where there is no reviewer fan-out (no shared resolver
 * needed). Honors `adapters.lead.{model_id,fallback_chain}`.
 */
export function buildLeadAdapter(cwd: string): Adapter {
  const cfg = readAdaptersConfig(cwd);
  const chain = resolveChain(cfg.lead);
  if (chain === undefined) return new ClaudeAdapter();
  return new ClaudeAdapter({
    models: toModelInfo(chain, "claude"),
    defaultModel: chain[0],
  });
}

/** Optional one-line notice sink (defaults to a stderr writer). */
export interface BuildReviewLoopOptions {
  /** Emit a one-line warning/notice (no trailing newline required). */
  readonly warn?: (line: string) => void;
}

function defaultWarn(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Construct the Reviewer A seat from its per-seat config. The vendor is
 * `adapters.reviewer_a.adapter` ("codex" | "claude"); absent → codex,
 * preserving the historical default. A claude Reviewer A is wired to the
 * shared Claude `resolver` (SPEC §11 coupled fallback, like lead +
 * Reviewer B) and carries the security/ops persona; a codex Reviewer A
 * is pinned from its own configured fallback chain.
 */
function buildReviewerA(
  cfg: AdapterRoleConfig | undefined,
  resolver: ClaudeResolver,
): Adapter {
  const chain = resolveChain(cfg);
  if (cfg?.adapter === "claude") {
    return new ClaudeReviewerAAdapter({
      resolver,
      ...(chain !== undefined
        ? { models: toModelInfo(chain, "claude"), defaultModel: chain[0] }
        : {}),
    });
  }
  // Default (codex) — unchanged behavior.
  return chain !== undefined
    ? new CodexAdapter({
        models: toModelInfo(chain, "codex"),
        defaultModel: chain[0],
      })
    : new CodexAdapter();
}

/**
 * Build the full review-loop adapter trio from `.samo/config.json`.
 * Lead + reviewer-B share one config-pinned {@link ClaudeResolver}
 * (coupled fallback). Reviewer-A's vendor is selected per seat via
 * `adapters.reviewer_a.adapter` ("codex" | "claude"); absent → codex
 * (the pinned default). A codex Reviewer A is pinned from its own
 * configured chain; a claude Reviewer A ({@link ClaudeReviewerAAdapter})
 * joins the shared Claude resolver (coupled fallback) and carries the
 * same security/ops persona as the codex seat. Absent config falls back
 * to pinned defaults.
 *
 * SPEC §11 couples reviewer-B to the lead's shared Claude resolver, so a
 * distinct `adapters.reviewer_b.{model_id,fallback_chain}` is INERT. That
 * coupling is intentional, but silently ignoring a divergent reviewer_b
 * config is a footgun (samospec #180 FIX 3): when reviewer_b's resolved
 * chain differs from lead's we emit a one-line warning via `opts.warn`
 * (stderr by default) explaining the config is ignored. The coupling
 * behavior itself is unchanged.
 */
export function buildReviewLoopAdaptersFromConfig(
  cwd: string,
  opts: BuildReviewLoopOptions = {},
): {
  readonly lead: Adapter;
  readonly reviewerA: Adapter;
  readonly reviewerB: Adapter;
} {
  const cfg = readAdaptersConfig(cwd);
  const warn = opts.warn ?? defaultWarn;

  // SPEC §11 coupling footgun warning (FIX 3): reviewer_b shares the
  // lead's resolver, so a reviewer_b chain that differs from lead's is
  // ignored. Warn (once) rather than silently dropping it. Compared on
  // the RESOLVED chains (sentinels stripped, pin de-duped) so equivalent
  // configs written differently don't false-positive.
  const leadResolved = resolveChain(cfg.lead);
  const reviewerBResolved = resolveChain(cfg.reviewer_b);
  if (
    reviewerBResolved !== undefined &&
    JSON.stringify(reviewerBResolved) !== JSON.stringify(leadResolved)
  ) {
    warn(
      "samospec: adapters.reviewer_b model config " +
        `(${reviewerBResolved.join(" -> ")}) differs from adapters.lead ` +
        `(${(leadResolved ?? ["<default>"]).join(" -> ")}) but is ignored: ` +
        "reviewer_b is coupled to the lead's shared Claude resolver per " +
        "SPEC §11 (coupled fallback). Set reviewer_b to match lead to " +
        "silence this warning.",
    );
  }

  // Shared Claude resolver (lead + reviewer B).
  const resolver = buildClaudeResolver(cfg);
  const leadChain = resolveChain(cfg.lead);
  const lead = new ClaudeAdapter({
    resolver,
    ...(leadChain !== undefined
      ? { models: toModelInfo(leadChain, "claude"), defaultModel: leadChain[0] }
      : {}),
  });
  const reviewerBChain = resolveChain(cfg.reviewer_b);
  const reviewerB = new ClaudeReviewerBAdapter({
    resolver,
    ...(reviewerBChain !== undefined
      ? {
          models: toModelInfo(reviewerBChain, "claude"),
          defaultModel: reviewerBChain[0],
        }
      : {}),
  });

  // Reviewer A: vendor is selectable per seat (default codex, unchanged).
  // A claude Reviewer A joins the shared resolver (coupled fallback) like
  // the lead + Reviewer B; a codex Reviewer A is pinned from its own
  // configured chain.
  const reviewerA = buildReviewerA(cfg.reviewer_a, resolver);

  return { lead, reviewerA, reviewerB };
}
