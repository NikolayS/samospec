// Copyright 2026 Nikolay Samokhvalov.

/**
 * Public API for the context subsystem (SPEC §7).
 *
 * Consumers should only import from this file. Individual modules are
 * internal and may be reorganized without notice.
 */

export {
  discoverContext,
  listTrackedAndUntracked,
  refuseOutboundSymlinks,
  type ContextPhase,
  type DiscoverContextArgs,
  type DiscoverContextResult,
} from "./discover.ts";
export {
  DEFAULT_CONTEXT_BUDGETS,
  estimateTokens,
  fitFilesToBudget,
  type BudgetFile,
  type BudgetPlan,
  type ContextBudgets,
  type FitFilesToBudgetArgs,
} from "./budget.ts";
export { ENVELOPE_SYSTEM_NOTE, wrap, type WrapArgs } from "./envelope.ts";
export {
  buildDeterministicGist,
  computeBlobSha,
  gistCachePath,
  parseImportsExports,
  readOrCreateGist,
  type BuildDeterministicGistArgs,
  type ImportsExports,
  type ReadOrCreateGistArgs,
  type ReadOrCreateGistResult,
} from "./gist.ts";
export {
  buildGitLogMap,
  collectAuthorDates,
  parseGitLogBatch,
  type CollectAuthorDatesArgs,
  type CollectAuthorDatesResult,
  type GitLogEntry,
} from "./git-meta.ts";
export {
  applyIgnore,
  DEFAULT_DENYLIST,
  loadSamospecIgnore,
  MAX_ASSET_BYTES,
  parseIgnorePatterns,
  type ApplyIgnoreArgs,
  type IgnorePattern,
} from "./ignore.ts";
export { isNoRead, NO_READ_PATTERNS } from "./no-read.ts";
export {
  contextJsonPath,
  contextJsonSchema,
  readContextJson,
  RISK_FLAGS,
  writeContextJson,
  type ContextJson,
  type FileEntry,
  type RiskFlag,
} from "./provenance.ts";
export {
  classifyBucket,
  CONTEXT_BUCKETS,
  rankFiles,
  type ContextBucket,
  type RankedFile,
  type RankFilesArgs,
} from "./rank.ts";
export {
  classifyTruncateKind,
  LARGE_FILE_LINE_THRESHOLD,
  truncateContent,
  type BlameHunk,
  type TruncateContentArgs,
  type TruncateKind,
  type TruncateResult,
} from "./truncate.ts";
