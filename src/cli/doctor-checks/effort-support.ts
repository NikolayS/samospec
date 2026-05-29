// Copyright 2026 Nikolay Samokhvalov.

import {
  CLAUDE_MIN_EFFORT_VERSION,
  claudeSupportsEffortFlag,
} from "../../adapter/claude.ts";
import type { Adapter } from "../../adapter/types.ts";

import { CheckStatus, type CheckResult } from "../doctor-format.ts";

/** Vendor string the Claude adapter(s) report. */
const CLAUDE_VENDOR = "claude" as const;

export interface AdapterBinding {
  readonly label: string;
  readonly adapter: Adapter;
}

export interface CheckEffortSupportArgs {
  readonly adapters: readonly AdapterBinding[];
}

/**
 * samospec appends `--effort <level>` to EVERY `claude` work-call spawn
 * (see src/adapter/claude.ts). A `claude` CLI older than
 * {@link CLAUDE_MIN_EFFORT_VERSION} rejects that flag, so every call would
 * fail. This doctor check probes each Claude-vendor adapter's version and
 * WARNs (never FAILs) when the installed CLI is too old, naming the
 * minimum version (samospec #180 FIX 5).
 *
 * Non-Claude adapters and not-installed / unknown-version CLIs are
 * skipped — availability is the availability check's job, and an
 * unparseable version must not cry wolf.
 */
export async function checkEffortSupport(
  args: CheckEffortSupportArgs,
): Promise<CheckResult> {
  const details: string[] = [];
  let worst: CheckStatus = CheckStatus.Ok;

  for (const { label, adapter } of args.adapters) {
    if (adapter.vendor !== CLAUDE_VENDOR) continue;
    let version: string | undefined;
    try {
      const det = await adapter.detect();
      if (!det.installed) continue; // availability check handles this.
      version = det.version;
    } catch {
      continue; // detect failures are the availability check's concern.
    }
    if (version === undefined || version === "unknown") continue;
    if (!claudeSupportsEffortFlag(version)) {
      worst = CheckStatus.Warn;
      details.push(
        `${label}: claude ${version} predates --effort (added in ` +
          `v${CLAUDE_MIN_EFFORT_VERSION}); every call passes --effort and ` +
          `will fail — upgrade claude to v${CLAUDE_MIN_EFFORT_VERSION} or later.`,
      );
    } else {
      details.push(`${label}: claude ${version} supports --effort`);
    }
  }

  if (details.length === 0) {
    details.push("no Claude CLI bound; --effort support not checked");
  }

  return {
    status: worst,
    label: "claude --effort support",
    message: details.join("; "),
    details,
  };
}
