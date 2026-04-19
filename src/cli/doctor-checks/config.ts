// Copyright 2026 Nikolay Samokhvalov.

import { existsSync, readFileSync } from "node:fs";

import { CheckStatus, type CheckResult } from "../doctor-format.ts";
import { DEFAULT_CONFIG } from "../init.ts";

export interface CheckConfigArgs {
  readonly configPath: string;
}

/**
 * Sanity-check `.samospec/config.json`:
 *   - FAIL if missing or malformed.
 *   - WARN if the pinned lead / reviewer models differ from release
 *     metadata (SPEC §11 — "pinned per samospec release; no runtime
 *     strongest-available discovery"). Drift is flagged but not blocked
 *     so power users can pin alternate models via `config set`.
 *   - OK otherwise.
 */
export function checkConfig(args: CheckConfigArgs): CheckResult {
  if (!existsSync(args.configPath)) {
    return {
      status: CheckStatus.Fail,
      label: "config",
      message: `${args.configPath} not found — run \`samospec init\``,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(args.configPath, "utf8");
  } catch (err) {
    return {
      status: CheckStatus.Fail,
      label: "config",
      message: `cannot read ${args.configPath}: ${(err as Error).message}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      status: CheckStatus.Fail,
      label: "config",
      message: `${args.configPath} is malformed JSON: ${(err as Error).message}`,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      status: CheckStatus.Fail,
      label: "config",
      message: `${args.configPath} malformed: top-level must be an object`,
    };
  }

  const cfg = parsed as Record<string, unknown>;
  const adapters = cfg["adapters"];
  if (typeof adapters !== "object" || adapters === null) {
    return {
      status: CheckStatus.Fail,
      label: "config",
      message: `${args.configPath} missing 'adapters'`,
    };
  }

  const driftMessages: string[] = [];
  const roles: readonly (keyof typeof DEFAULT_CONFIG.adapters)[] = [
    "lead",
    "reviewer_a",
    "reviewer_b",
  ];
  const adapterRecord = adapters as Record<string, unknown>;
  for (const role of roles) {
    const current = adapterRecord[role];
    const expected = DEFAULT_CONFIG.adapters[role];
    if (typeof current !== "object" || current === null) {
      driftMessages.push(`${role} missing`);
      continue;
    }
    const cRec = current as Record<string, unknown>;
    if (cRec["model_id"] !== expected.model_id) {
      driftMessages.push(
        `${role}.model_id pinned to ${expected.model_id} ` +
          `but config has ${JSON.stringify(cRec["model_id"])}`,
      );
    }
    if (cRec["adapter"] !== expected.adapter) {
      driftMessages.push(
        `${role}.adapter pinned to ${expected.adapter} ` +
          `but config has ${JSON.stringify(cRec["adapter"])}`,
      );
    }
  }

  if (driftMessages.length > 0) {
    return {
      status: CheckStatus.Warn,
      label: "config",
      message: `pinned-model drift: ${driftMessages.join(", ")}`,
    };
  }

  return {
    status: CheckStatus.Ok,
    label: "config",
    message: `${args.configPath} parses; pinned models match`,
  };
}
