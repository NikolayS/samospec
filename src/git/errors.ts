// Copyright 2026 Nikolay Samokhvalov.

/**
 * Error thrown by the git layer whenever it refuses an operation that would
 * land on a protected branch. The exit code is `2` per SPEC §8 (branch/commit
 * refusal matches the "lock contention" / "unsafe state" family).
 */
export class ProtectedBranchError extends Error {
  public readonly exitCode = 2;
  public readonly branchName: string;

  public constructor(branchName: string, message?: string) {
    super(
      message ??
        `Refusing to operate on protected branch '${branchName}'. ` +
          `Create a feature branch first, or override the protection ` +
          `via git config or '.samo/config.json'.`,
    );
    this.name = "ProtectedBranchError";
    this.branchName = branchName;
  }
}

/**
 * Error thrown when a slug, config value, or branch-name argument violates
 * the grammar or uniqueness contract. Not a safety failure — exit code 1.
 */
export class GitLayerUsageError extends Error {
  public readonly exitCode = 1;

  public constructor(message: string) {
    super(message);
    this.name = "GitLayerUsageError";
  }
}
