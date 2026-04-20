// Copyright 2026 Nikolay Samokhvalov.

import { spawnSync } from "node:child_process";
import path from "node:path";

import type { Adapter } from "../adapter/types.ts";
import { isProtected } from "../git/protected.ts";
import {
  CheckStatus,
  formatStatusLine,
  shouldUseColor,
  worstStatus,
  type CheckResult,
} from "./doctor-format.ts";
import { checkCliAvailability } from "./doctor-checks/availability.ts";
import { checkAuthStatus, type ProbeResult } from "./doctor-checks/auth.ts";
import { checkGitHealth } from "./doctor-checks/git.ts";
import { checkLockfile } from "./doctor-checks/lock.ts";
import { checkConfig } from "./doctor-checks/config.ts";
import { checkGlobalConfig } from "./doctor-checks/global-config.ts";
import { checkEntropy } from "./doctor-checks/entropy.ts";
import { checkPushConsent } from "./doctor-checks/push-consent.ts";
import { checkCalibration } from "./doctor-checks/calibration.ts";
import { checkPrCapability } from "./doctor-checks/pr-capability.ts";

export interface DoctorAdapterBinding {
  readonly label: string;
  readonly adapter: Adapter;
}

export interface RunDoctorArgs {
  readonly cwd: string;
  readonly homeDir: string;
  readonly adapters: readonly DoctorAdapterBinding[];
  // Injectable probes — tests pass closures; production wires the real
  // spawnSync-based git helpers.
  readonly isGitRepo?: () => boolean;
  readonly currentBranch?: () => string;
  readonly hasRemote?: () => boolean;
  readonly remoteUrl?: () => string | null;
  readonly isProtected?: () => boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly isTty?: boolean;
  readonly now?: number;
  readonly maxWallClockMinutes?: number;
  /**
   * Override for push-consent remote enumeration. Each entry is
   * `{ name, url }`. When omitted, production enumerates via `git remote`.
   */
  readonly remotes?: readonly { readonly name: string; readonly url: string }[];
  /**
   * Injectable PR-capability runners for testability.
   * When omitted, production uses the real `gh`/`glab` probes.
   */
  readonly ghRunner?: () => { status: number; stdout: string; stderr: string };
  readonly glabRunner?: () => {
    status: number;
    stdout: string;
    stderr: string;
  };
  /**
   * Injectable auth probe for testability (SPEC §11).
   * Spawns a tiny prompt through the named adapter CLI and returns the
   * result. Tests inject a mock; production wires the real spawn-based
   * probe. When omitted, no live probe is executed and auth is checked
   * via auth_status() only.
   */
  readonly authProbe?: (label: string) => Promise<ProbeResult>;
}

export interface RunDoctorResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function defaultIsGitRepo(cwd: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
  });
  return r.status === 0 && r.stdout.trim() === "true";
}

function defaultCurrentBranch(cwd: string): string {
  // Prefer symbolic-ref: works even in a brand-new repo with no commits yet,
  // where `rev-parse --abbrev-ref HEAD` fails with an "unknown revision" error.
  const sym = spawnSync("git", ["symbolic-ref", "--short", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (sym.status === 0) {
    const name = sym.stdout.trim();
    if (name.length > 0) return name;
  }
  const rev = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  if (rev.status === 0) {
    const name = rev.stdout.trim();
    if (name.length > 0) return name;
  }
  throw new Error(
    `cannot read current branch: ${(sym.stderr || rev.stderr || "unknown").trim()}`,
  );
}

function defaultHasRemote(cwd: string): boolean {
  const r = spawnSync("git", ["remote"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return false;
  return r.stdout.trim().length > 0;
}

function defaultRemoteUrl(cwd: string): string | null {
  const r = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  const out = r.stdout.trim();
  return out.length > 0 ? out : null;
}

function defaultRemotes(
  cwd: string,
): { readonly name: string; readonly url: string }[] {
  const names = spawnSync("git", ["remote"], { cwd, encoding: "utf8" });
  if (names.status !== 0) return [];
  const remoteNames = names.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out: { readonly name: string; readonly url: string }[] = [];
  for (const name of remoteNames) {
    const url = spawnSync("git", ["remote", "get-url", name], {
      cwd,
      encoding: "utf8",
    });
    if (url.status === 0) {
      const u = url.stdout.trim();
      if (u.length > 0) out.push({ name, url: u });
    }
  }
  return out;
}

export async function runDoctor(args: RunDoctorArgs): Promise<RunDoctorResult> {
  const env = args.env ?? process.env;
  const isTty = args.isTty ?? process.stdout.isTTY ?? false;
  const color = shouldUseColor({ env, isTty });
  const now = args.now ?? Date.now();
  const maxWallClockMinutes = args.maxWallClockMinutes ?? 240;

  const isGitRepo = args.isGitRepo ?? (() => defaultIsGitRepo(args.cwd));
  const currentBranch =
    args.currentBranch ?? (() => defaultCurrentBranch(args.cwd));
  const hasRemote = args.hasRemote ?? (() => defaultHasRemote(args.cwd));
  const remoteUrl = args.remoteUrl ?? (() => defaultRemoteUrl(args.cwd));
  const protectedProbe =
    args.isProtected ??
    (() => {
      try {
        const b = currentBranch();
        return isProtected(b, { repoPath: args.cwd });
      } catch {
        return false;
      }
    });

  const results: CheckResult[] = [];

  results.push(await checkCliAvailability({ adapters: args.adapters }));
  results.push(
    await checkAuthStatus({
      adapters: args.adapters,
      ...(args.authProbe !== undefined ? { probe: args.authProbe } : {}),
    }),
  );
  results.push(
    checkGitHealth({
      isGitRepo,
      currentBranch,
      hasRemote,
      remoteUrl,
      isProtected: protectedProbe,
    }),
  );
  results.push(
    checkLockfile({
      lockPath: path.join(args.cwd, ".samo", ".lock"),
      now,
      maxWallClockMinutes,
    }),
  );
  results.push(
    checkConfig({
      configPath: path.join(args.cwd, ".samo", "config.json"),
    }),
  );
  results.push(checkGlobalConfig({ homeDir: args.homeDir }));
  results.push(checkEntropy({ cwd: args.cwd }));

  // New checks (Issue #34).
  const remotes = args.remotes ?? defaultRemotes(args.cwd);
  results.push(checkPushConsent({ repoPath: args.cwd, remotes }));
  results.push(
    checkCalibration({
      configPath: path.join(args.cwd, ".samo", "config.json"),
    }),
  );
  results.push(
    checkPrCapability({
      ...(args.ghRunner !== undefined ? { gh: args.ghRunner } : {}),
      ...(args.glabRunner !== undefined ? { glab: args.glabRunner } : {}),
    }),
  );

  const lines: string[] = [];
  for (const r of results) {
    lines.push(
      formatStatusLine({
        status: r.status,
        label: r.label,
        message: r.message,
        color,
      }),
    );
    if (r.details !== undefined && r.details.length > 1) {
      for (const d of r.details) lines.push(`        ${d}`);
    }
  }

  const roll = worstStatus(results);
  const summary =
    roll === CheckStatus.Fail
      ? "samospec doctor: one or more critical checks failed."
      : roll === CheckStatus.Warn
        ? "samospec doctor: passes with warnings."
        : "samospec doctor: all green.";
  lines.push("");
  lines.push(summary);

  return {
    exitCode: roll === CheckStatus.Fail ? 1 : 0,
    stdout: `${lines.join("\n")}\n`,
    stderr: "",
  };
}
