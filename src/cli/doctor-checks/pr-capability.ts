// Copyright 2026 Nikolay Samokhvalov.

/**
 * Doctor check — PR-open capability.
 *
 * `samospec publish` opens a PR via `gh` (preferred) or `glab`. This
 * check detects whether either tool is installed AND authenticated so
 * users know before running publish whether they can expect an auto-PR.
 *
 * Status:
 *   - OK    — `gh` or `glab` is installed and authenticated.
 *   - WARN  — at least one tool is installed but not authenticated,
 *             OR neither tool is installed (PR creation is an optional
 *             convenience, not a required capability — see review of
 *             Issue #34). The overall `samospec doctor` exit code is
 *             0 when this is the only non-OK check.
 *
 * Uses the existing `probePrCapability` helper from `push-consent.ts`
 * with injectable runners for testability.
 */

import { CheckStatus, type CheckResult } from "../doctor-format.ts";
import {
  probePrCapability,
  type PrCapabilityRunner,
} from "../../git/push-consent.ts";

export interface PrCapabilityCheckArgs {
  /** Injectable runner for `gh auth status`. */
  readonly gh?: () => PrCapabilityRunner;
  /** Injectable runner for `glab auth status`. */
  readonly glab?: () => PrCapabilityRunner;
}

export function checkPrCapability(
  args: PrCapabilityCheckArgs = {},
): CheckResult {
  const probe = probePrCapability({
    ...(args.gh !== undefined ? { gh: args.gh } : {}),
    ...(args.glab !== undefined ? { glab: args.glab } : {}),
  });

  if (probe.available) {
    return {
      status: CheckStatus.Ok,
      label: "pr-capability",
      message: `PR creation available via ${probe.tool ?? "unknown"}`,
    };
  }

  // probePrCapability returns { available: false } if either:
  //   (a) the tool is not installed (spawn throws ENOENT), or
  //   (b) the tool is installed but auth status returned non-zero.
  // Distinguish by attempting detection without auth check.
  const ghInstalled = isInstalled(args.gh);
  const glabInstalled = isInstalled(args.glab);

  if (!ghInstalled && !glabInstalled) {
    // Missing optional tooling is WARN, not FAIL: PR creation is a
    // convenience (publish still writes the blueprint and commit
    // locally). The user can open a PR by hand via the compare URL
    // that publish emits.
    return {
      status: CheckStatus.Warn,
      label: "pr-capability",
      message:
        "neither gh nor glab found on PATH — " +
        "install one to enable auto-PR on publish " +
        "(publish still works locally; PR can be opened manually)",
    };
  }

  const tools: string[] = [];
  if (ghInstalled) tools.push("gh");
  if (glabInstalled) tools.push("glab");

  return {
    status: CheckStatus.Warn,
    label: "pr-capability",
    message:
      `${tools.join(", ")} installed but not authenticated — ` +
      "run `gh auth login` or `glab auth login` to enable auto-PR",
  };
}

/**
 * Return true when the tool executable is found on PATH (exit 0 or any
 * non-ENOENT failure). ENOENT means the binary is not installed.
 */
function isInstalled(runner: (() => PrCapabilityRunner) | undefined): boolean {
  if (runner === undefined) return false;
  try {
    runner(); // We only care whether it throws ENOENT, not the exit code.
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code !== "ENOENT";
  }
}
