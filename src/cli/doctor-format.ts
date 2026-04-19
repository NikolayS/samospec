// Copyright 2026 Nikolay Samokhvalov.

/**
 * Small status-line formatter for `samospec doctor`.
 *
 * Three statuses (SPEC §10): OK, WARN, FAIL.
 * Color is opt-in per call; callers decide based on `NO_COLOR` + TTY.
 * No emoji — plain ASCII labels keep output scrape-friendly and comply
 * with the project tone (see CLAUDE.md).
 */

export const CheckStatus = {
  Ok: "OK",
  Warn: "WARN",
  Fail: "FAIL",
} as const;
export type CheckStatus = (typeof CheckStatus)[keyof typeof CheckStatus];

export interface CheckResult {
  readonly status: CheckStatus;
  readonly label: string;
  readonly message: string;
  readonly details?: readonly string[];
}

export interface FormatStatusLineArgs {
  readonly status: CheckStatus;
  readonly label: string;
  readonly message: string;
  readonly color: boolean;
}

const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_RED = "\u001b[31m";

function colorFor(status: CheckStatus): string {
  switch (status) {
    case CheckStatus.Ok:
      return ANSI_GREEN;
    case CheckStatus.Warn:
      return ANSI_YELLOW;
    case CheckStatus.Fail:
      return ANSI_RED;
  }
}

/**
 * Format a single status line, e.g.:
 *   [ OK ]  git             repo detected, branch feature/foo
 *   [WARN]  auth            subscription auth — wall-clock caps enforced
 *   [FAIL]  config          config.json malformed
 */
export function formatStatusLine(args: FormatStatusLineArgs): string {
  const tag = args.status.padEnd(4, " ");
  const label = args.label.padEnd(24, " ");
  if (args.color) {
    const c = colorFor(args.status);
    return `[${c}${ANSI_BOLD}${tag}${ANSI_RESET}]  ${label}${args.message}`;
  }
  return `[${tag}]  ${label}${args.message}`;
}

export interface ShouldUseColorArgs {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTty: boolean;
}

/**
 * Color output is disabled when NO_COLOR is set (any non-empty value, per
 * https://no-color.org/) or when stdout is not a TTY (pipes, files, CI).
 */
export function shouldUseColor(args: ShouldUseColorArgs): boolean {
  const noColor = args.env["NO_COLOR"];
  if (typeof noColor === "string" && noColor.length > 0) return false;
  return args.isTty;
}

/** Roll a list of check results into the worst-severity status. */
export function worstStatus(results: readonly CheckResult[]): CheckStatus {
  if (results.some((r) => r.status === CheckStatus.Fail))
    return CheckStatus.Fail;
  if (results.some((r) => r.status === CheckStatus.Warn))
    return CheckStatus.Warn;
  return CheckStatus.Ok;
}
