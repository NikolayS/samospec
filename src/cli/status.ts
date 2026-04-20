// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §10 `samospec status [<slug>]` — session dashboard.
 *
 * Prints:
 *   - phase
 *   - round state (round N + state)
 *   - current version
 *   - next action (one-line remediation pointer)
 *   - running cost (per adapter) — subscription-auth adapters shown as
 *     `unknown (subscription auth)`
 *   - remaining wall-clock
 *   - worst-case duration of one more round (SPEC §11 overrun rule)
 *   - subscription-auth flag (from any adapter)
 *   - degraded-resolution summary if applicable
 *
 * Pure function — takes adapter auth_status + config, emits a string.
 * No commits, no network.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import type { Adapter, AuthStatus, Usage } from "../adapter/types.ts";
import { loadPersistedConsent } from "../git/push-consent.ts";
import { stateSchema } from "../state/types.ts";
import {
  detectDegradedResolution,
  formatDegradedSummary,
  type AdapterResolutionSnapshot,
} from "../loop/degradation.ts";
import {
  worstCaseRoundDuration,
  type CallTimeoutsMs,
} from "../policy/wallclock.ts";
import type { State } from "../state/types.ts";
import { specPaths } from "./new.ts";

// ---------- types ----------

export interface StatusAdapterBinding {
  readonly role: "lead" | "reviewer_a" | "reviewer_b";
  readonly adapter: Adapter;
  readonly usage?: Usage;
}

export interface StatusInput {
  readonly cwd: string;
  readonly slug: string;
  readonly now: string;
  readonly adapters: readonly StatusAdapterBinding[];
  readonly callTimeouts?: CallTimeoutsMs;
  readonly maxWallClockMs?: number;
  readonly sessionStartedAtMs?: number;
  readonly nowMs?: number;
  readonly resolutions?: {
    readonly lead: AdapterResolutionSnapshot;
    readonly reviewer_a: AdapterResolutionSnapshot;
    readonly reviewer_b: AdapterResolutionSnapshot;
    readonly coupled_fallback: boolean;
  };
}

export interface StatusResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_WALL_CLOCK_MS = 240 * 60 * 1000;
const DEFAULT_CALL_TIMEOUTS: CallTimeoutsMs = {
  criticA_ms: 300_000,
  criticB_ms: 300_000,
  revise_ms: 600_000,
};

// ---------- main ----------

export async function runStatus(input: StatusInput): Promise<StatusResult> {
  const paths = specPaths(input.cwd, input.slug);
  if (!existsSync(paths.statePath)) {
    return {
      exitCode: 1,
      stdout: "",
      stderr:
        `samospec: no spec found for slug '${input.slug}'. ` +
        `Run \`samospec new ${input.slug}\` to start one.\n`,
    };
  }
  const parsedState = stateSchema.safeParse(
    JSON.parse(readFileSync(paths.statePath, "utf8")) as unknown,
  );
  if (!parsedState.success) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `samospec: state.json at ${paths.statePath} is malformed.\n`,
    };
  }
  const state: State = parsedState.data;

  const lines: string[] = [];
  lines.push(`samospec status — ${input.slug}`);
  lines.push("");
  lines.push(`- phase: ${state.phase}`);
  lines.push(`- round: ${String(state.round_index)} (${state.round_state})`);
  lines.push(`- version: ${state.version}`);

  // Next action.
  const nextAction = computeNextAction(state, input.slug);
  if (nextAction.length > 0) {
    lines.push(`- next: ${nextAction}`);
  }

  // Running cost per adapter + subscription-auth flag.
  const authPromises = input.adapters.map(async (b) => {
    try {
      const s = await b.adapter.auth_status();
      return {
        role: b.role,
        vendor: b.adapter.vendor,
        status: s,
        usage: b.usage,
      };
    } catch {
      return {
        role: b.role,
        vendor: b.adapter.vendor,
        status: { authenticated: false } as AuthStatus,
        usage: b.usage,
      };
    }
  });
  const auths = await Promise.all(authPromises);
  const anySubscriptionAuth = auths.some(
    (a) => a.status.subscription_auth === true,
  );

  lines.push(`- running cost:`);
  for (const a of auths) {
    const tag = `${a.role} (${a.vendor})`;
    if (a.status.subscription_auth === true) {
      lines.push(`  - ${tag}: unknown (subscription auth)`);
      continue;
    }
    const usage = a.usage;
    if (usage === undefined || usage === null) {
      lines.push(`  - ${tag}: $0.00 (no usage reported)`);
      continue;
    }
    if (typeof usage.cost_usd === "number") {
      lines.push(`  - ${tag}: $${usage.cost_usd.toFixed(4)}`);
    } else {
      lines.push(
        `  - ${tag}: ${String(usage.input_tokens + usage.output_tokens)} tokens`,
      );
    }
  }

  if (anySubscriptionAuth) {
    lines.push(
      `- subscription auth: enabled — token budgets disabled for subscribed seat(s).`,
    );
  }

  // Wall-clock.
  const callTimeouts = input.callTimeouts ?? DEFAULT_CALL_TIMEOUTS;
  const wallClockMs = input.maxWallClockMs ?? DEFAULT_WALL_CLOCK_MS;
  const sessionStartedMs =
    input.sessionStartedAtMs ?? Date.parse(state.created_at);
  const nowMs = input.nowMs ?? Date.parse(input.now);
  const elapsed = Math.max(0, nowMs - sessionStartedMs);
  const remaining = Math.max(0, wallClockMs - elapsed);
  const worstCase = worstCaseRoundDuration(callTimeouts);
  lines.push(
    `- wall-clock: remaining ${fmtMinutes(remaining)} / budget ${fmtMinutes(wallClockMs)}`,
  );
  lines.push(
    `- worst-case one more round: ${fmtMinutes(worstCase)} (SPEC §11 overrun rule)`,
  );
  if (remaining < worstCase) {
    lines.push(
      `- warning: remaining wall-clock is less than worst-case one-more-round duration; next \`samospec iterate\` will halt with reason \`wall-clock\`.`,
    );
  }

  // Degraded resolution — SPEC §11 required line form.
  const resolutions =
    input.resolutions ?? inferStatusResolutions(input.adapters, state);
  const deg = detectDegradedResolution(resolutions);
  if (deg.degraded) {
    lines.push(`- ${formatDegradedSummary(deg)}`);
  }

  // Push consent (SPEC §8) — one bullet per configured remote.
  const consentLines = renderPushConsent(input.cwd);
  for (const line of consentLines) {
    lines.push(line);
  }

  // Exit reason (when halted).
  if (state.exit !== null) {
    lines.push(
      `- last exit: code=${String(state.exit.code)} reason=${state.exit.reason} (round ${String(state.exit.round_index)})`,
    );
  }

  return {
    exitCode: 0,
    stdout: `${lines.join("\n")}\n`,
    stderr: "",
  };
}

// ---------- helpers ----------

function computeNextAction(state: State, slug: string): string {
  if (state.round_state === "lead_terminal") {
    return `edit .samo/spec/${slug}/SPEC.md manually to recover`;
  }
  if (state.phase === "draft" && state.round_state === "committed") {
    return `run \`samospec iterate\` to start the review loop`;
  }
  if (state.phase === "review_loop" && state.round_state === "committed") {
    return `run \`samospec iterate\` to continue reviewing`;
  }
  if (state.round_state === "running") {
    return `run \`samospec resume ${slug}\` to recover from an in-flight round`;
  }
  if (state.round_state === "reviews_collected") {
    return `run \`samospec resume ${slug}\` to finalize the lead revision`;
  }
  if (state.round_state === "lead_revised") {
    return `run \`samospec resume ${slug}\` to commit the lead's revision`;
  }
  return "";
}

function fmtMinutes(ms: number): string {
  const mins = ms / 60000;
  return `${mins.toFixed(1)}min`;
}

function renderPushConsent(cwd: string): string[] {
  const remotes = listGitRemotes(cwd);
  if (remotes.length === 0) return [];
  const out: string[] = [];
  out.push(`- push consent:`);
  for (const { name, url } of remotes) {
    let state: "granted" | "refused" | "not yet decided";
    try {
      const persisted = loadPersistedConsent({ repoPath: cwd, remoteUrl: url });
      if (persisted === true) state = "granted";
      else if (persisted === false) state = "refused";
      else state = "not yet decided";
    } catch {
      state = "not yet decided";
    }
    out.push(`  - ${name} → ${state} (${url})`);
  }
  return out;
}

function listGitRemotes(cwd: string): { name: string; url: string }[] {
  const res = spawnSync("git", ["remote", "-v"], { cwd, encoding: "utf8" });
  if ((res.status ?? 1) !== 0) return [];
  const seen = new Map<string, string>();
  for (const line of (res.stdout ?? "").split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const name = parts[0];
    const url = parts[1];
    if (name === undefined || url === undefined) continue;
    if (!seen.has(name)) seen.set(name, url);
  }
  return Array.from(seen, ([name, url]) => ({ name, url }));
}

function inferStatusResolutions(
  bindings: readonly StatusAdapterBinding[],
  state: State,
): {
  readonly lead: AdapterResolutionSnapshot;
  readonly reviewer_a: AdapterResolutionSnapshot;
  readonly reviewer_b: AdapterResolutionSnapshot;
  readonly coupled_fallback: boolean;
} {
  const roleOf = (
    role: "lead" | "reviewer_a" | "reviewer_b",
  ): StatusAdapterBinding | undefined => bindings.find((b) => b.role === role);
  const stateAdapters = state.adapters ?? {};
  return {
    lead: {
      adapter: roleOf("lead")?.adapter.vendor ?? "claude",
      model_id: stateAdapters.lead?.model_id ?? "claude-opus-4-7",
    },
    reviewer_a: {
      adapter: roleOf("reviewer_a")?.adapter.vendor ?? "codex",
      model_id: stateAdapters.reviewer_a?.model_id ?? "gpt-5.1-codex-max",
    },
    reviewer_b: {
      adapter: roleOf("reviewer_b")?.adapter.vendor ?? "claude",
      model_id: stateAdapters.reviewer_b?.model_id ?? "claude-opus-4-7",
    },
    coupled_fallback: state.coupled_fallback,
  };
}
