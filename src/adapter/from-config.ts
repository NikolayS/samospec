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
import { ClaudeReviewerBAdapter } from "./claude-reviewer-b.ts";
import { ClaudeResolver } from "./claude-resolver.ts";
import { CodexAdapter } from "./codex.ts";
import type { Adapter, ModelInfo } from "./types.ts";

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
  const modelId = typeof r["model_id"] === "string" ? r["model_id"] : undefined;
  const chainRaw = r["fallback_chain"];
  const chain =
    Array.isArray(chainRaw) && chainRaw.every((x) => typeof x === "string")
      ? (chainRaw as readonly string[])
      : undefined;
  if (modelId === undefined && chain === undefined) return {};
  return {
    [role]: {
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
export function resolveChain(cfg: AdapterRoleConfig | undefined): string[] | undefined {
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
  return chain !== undefined ? new ClaudeResolver({ chain }) : new ClaudeResolver();
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

/**
 * Build the full review-loop adapter trio from `.samo/config.json`.
 * Lead + reviewer-B share one config-pinned {@link ClaudeResolver}
 * (coupled fallback); reviewer-A (codex) is pinned from its own
 * configured chain. Absent config falls back to pinned defaults.
 */
export function buildReviewLoopAdaptersFromConfig(cwd: string): {
  readonly lead: Adapter;
  readonly reviewerA: Adapter;
  readonly reviewerB: Adapter;
} {
  const cfg = readAdaptersConfig(cwd);

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

  // Reviewer A (codex).
  const reviewerAChain = resolveChain(cfg.reviewer_a);
  const reviewerA =
    reviewerAChain !== undefined
      ? new CodexAdapter({
          models: toModelInfo(reviewerAChain, "codex"),
          defaultModel: reviewerAChain[0],
        })
      : new CodexAdapter();

  return { lead, reviewerA, reviewerB };
}
