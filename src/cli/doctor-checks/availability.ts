// Copyright 2026 Nikolay Samokhvalov.

import type { Adapter } from "../../adapter/types.ts";

import { CheckStatus, type CheckResult } from "../doctor-format.ts";

export interface AdapterBinding {
  readonly label: string;
  readonly adapter: Adapter;
}

export interface CheckCliAvailabilityArgs {
  readonly adapters: readonly AdapterBinding[];
}

/**
 * Probes adapter `.detect()` for each bound CLI. Per SPEC §10 doctor
 * must surface the installed version + absolute path; lack of either
 * CLI is a FAIL at the aggregator level (Issue #4 acceptance).
 */
export async function checkCliAvailability(
  args: CheckCliAvailabilityArgs,
): Promise<CheckResult> {
  const details: string[] = [];
  let worst: CheckStatus = CheckStatus.Ok;

  for (const { label, adapter } of args.adapters) {
    try {
      const det = await adapter.detect();
      if (det.installed) {
        details.push(`${label}: installed ${det.version} at ${det.path}`);
      } else {
        details.push(`${label}: not installed`);
        worst = CheckStatus.Fail;
      }
    } catch (err) {
      details.push(`${label}: detect threw: ${(err as Error).message}`);
      worst = CheckStatus.Fail;
    }
  }

  return {
    status: worst,
    label: "CLI availability",
    message: details.join("; "),
    details,
  };
}
