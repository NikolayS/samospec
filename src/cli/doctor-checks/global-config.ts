// Copyright 2026 Nikolay Samokhvalov.

import { existsSync } from "node:fs";
import path from "node:path";

import { CheckStatus, type CheckResult } from "../doctor-format.ts";

export interface CheckGlobalConfigArgs {
  readonly homeDir: string;
}

/**
 * Detect global vendor-config files that can steer adapter behavior in
 * ways `samospec` cannot see (SPEC §14 threat model). Any hit is a WARN
 * — not a FAIL — because users may legitimately rely on these files;
 * awareness is the point, not prohibition.
 */
const GLOBAL_CONFIG_CANDIDATES: readonly string[] = [
  path.join(".claude", "CLAUDE.md"),
  path.join(".codex", "preamble.md"),
  path.join(".codex", "instructions.md"),
];

export function checkGlobalConfig(args: CheckGlobalConfigArgs): CheckResult {
  const hits: string[] = [];
  for (const relative of GLOBAL_CONFIG_CANDIDATES) {
    const abs = path.join(args.homeDir, relative);
    if (existsSync(abs)) {
      hits.push(abs);
    }
  }

  if (hits.length === 0) {
    return {
      status: CheckStatus.Ok,
      label: "global vendor-config",
      message: "no global CLAUDE.md / codex preamble detected",
    };
  }

  return {
    status: CheckStatus.Warn,
    label: "global vendor-config",
    message:
      `present — may steer adapter behavior: ${hits.join(", ")}. ` +
      `samospec runs adapters with a minimal env but cannot intercept ` +
      `files read from disk by the vendor CLI.`,
  };
}
