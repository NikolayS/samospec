// Copyright 2026 Nikolay Samokhvalov.

import { CheckStatus, type CheckResult } from "../doctor-format.ts";

import type { AdapterBinding } from "./availability.ts";

// Result shape returned by the probe helper (or a mock in tests).
export interface ProbeResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CheckAuthStatusArgs {
  readonly adapters: readonly AdapterBinding[];
  /**
   * Optional probe helper: spawns `echo "probe" | <cli> -p` with a
   * 10-second timeout and returns the result. Defaults to the real
   * spawn when not provided. Tests inject a mock.
   *
   * Called once per adapter label. If absent, auth is checked via
   * auth_status() only (no live probe).
   */
  readonly probe?: (label: string) => Promise<ProbeResult>;
}

// Map from adapter label to the required API key env var name.
const ADAPTER_API_KEY_ENV: Readonly<Record<string, string>> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
};

function apiKeyEnvForLabel(label: string): string {
  return ADAPTER_API_KEY_ENV[label] ?? "the required API key env var";
}

/**
 * Classify a probe result into a human-readable message.
 *
 * - Exit 0, sensible output → null (OK, no warning needed).
 * - Stdout contains "Invalid API key" → stale-key guidance.
 * - Output mentions "not authenticated" / "please run ... login" →
 *   login guidance.
 * - Other failure → generic message with first stderr/stdout line.
 */
function classifyProbeResult(
  label: string,
  result: ProbeResult,
): string | null {
  // Probe succeeded: exit 0 and non-empty output.
  if (result.ok && result.exitCode === 0) {
    return null;
  }

  const combined = (result.stdout + " " + result.stderr).toLowerCase();
  const apiKeyVar = apiKeyEnvForLabel(label);

  // Stale/invalid API key preempting OAuth.
  if (result.stdout.toLowerCase().includes("invalid api key")) {
    return (
      `${label}: ${label === "claude" ? "claude" : "codex"} -p probe failed ` +
      `with 'Invalid API key'. If you're using OAuth (${label === "claude" ? "claude /login" : "codex auth"}), ` +
      `a stale ${apiKeyVar} env var may be preempting it — try unsetting it. ` +
      `If you're using an API key, verify it's valid at ` +
      `${label === "claude" ? "https://console.anthropic.com/settings/keys" : "https://platform.openai.com/api-keys"}.`
    );
  }

  // Not authenticated at all.
  if (
    combined.includes("not authenticated") ||
    combined.includes("/login") ||
    combined.includes("please login") ||
    combined.includes("please run") ||
    combined.includes("authenticate")
  ) {
    return (
      `${label}: not authenticated. ` +
      `Run \`${label === "claude" ? "claude /login" : "codex auth"}\` to set up OAuth, ` +
      `or export ${apiKeyVar}.`
    );
  }

  // Generic failure: first line of stderr or stdout.
  const firstLine = (result.stderr.trim() || result.stdout.trim())
    .split("\n")[0]
    ?.trim();
  return `${label}: ${label === "claude" ? "claude" : "codex"} -p probe failed: ${firstLine ?? "unknown error"}`;
}

/**
 * Aggregates `auth_status()` + optional live probe across every bound
 * adapter. Statuses:
 *
 *   - OK   — every adapter authenticated and probe succeeded (or no
 *            probe provided and auth_status shows authenticated).
 *   - WARN — at least one adapter: probe failed (stale key, not logged
 *            in, or other error). The run is not blocked.
 *   - FAIL — any adapter not authenticated per auth_status().
 *
 * OAuth (subscription_auth:true) is a valid authenticated state.
 * The probe verifies the session is actually working.
 */
export async function checkAuthStatus(
  args: CheckAuthStatusArgs,
): Promise<CheckResult> {
  const details: string[] = [];
  let anyFailure = false;
  let anyProbeWarning = false;

  for (const { label, adapter } of args.adapters) {
    try {
      const status = await adapter.auth_status();
      if (!status.authenticated) {
        details.push(`${label}: not authenticated`);
        anyFailure = true;
        continue;
      }

      // Adapter is authenticated. Run probe if provided.
      if (args.probe !== undefined) {
        const probeResult = await args.probe(label);
        const probeMsg = classifyProbeResult(label, probeResult);
        if (probeMsg !== null) {
          details.push(probeMsg);
          anyProbeWarning = true;
          continue;
        }
      }

      // Authenticated and probe OK (or no probe).
      const account =
        status.account !== undefined ? ` (${status.account})` : "";
      const authMode = status.subscription_auth === true ? " via OAuth" : "";
      details.push(`${label}: authenticated${authMode}${account}`);
    } catch (err) {
      details.push(`${label}: auth_status threw: ${(err as Error).message}`);
      anyFailure = true;
    }
  }

  let checkStatus: CheckStatus;
  if (anyFailure) checkStatus = CheckStatus.Fail;
  else if (anyProbeWarning) checkStatus = CheckStatus.Warn;
  else checkStatus = CheckStatus.Ok;

  return {
    status: checkStatus,
    label: "auth",
    message: details.join("; "),
    details,
  };
}
