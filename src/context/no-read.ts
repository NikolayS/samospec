// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §7 — hard-coded no-read list for credential files.
 *
 * These patterns CANNOT be overridden by `.samo-ignore`. They are the
 * last line of defense against accidentally feeding a repository's
 * secrets to an LLM adapter.
 *
 * Matching semantics:
 * - Path-suffix match against POSIX-style relative paths.
 * - Case-insensitive (secrets on case-insensitive filesystems must still
 *   be refused).
 * - Accepts either a literal suffix or a glob-lite `*` wildcard within a
 *   single path segment (we deliberately avoid full glob semantics so
 *   the matcher remains auditable).
 */

/** Patterns that mark a path as "never readable". SPEC §7 canonical list. */
export const NO_READ_PATTERNS: readonly string[] = [
  // Dotfiles with credential conventions.
  ".env",
  ".env.*",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".dockercfg",
  // Tool-specific credential directories.
  ".aws/credentials",
  ".aws/config",
  ".ssh/*",
  ".kube/config",
  ".docker/config.json",
  // Private-key extensions.
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  // SSH key files (and their public-key pairs, since we refuse the pair).
  "id_rsa*",
  "id_ed25519*",
  "id_ecdsa*",
  // Credential-named files (generic, wide coverage).
  "credentials*",
  // .git/ is never readable regardless of how a file got listed. `**`
  // matches across path boundaries (see patternToRegex).
  ".git/**",
];

/**
 * Lower-case a path with forward slashes normalized; ensures tests run
 * identically on darwin/linux.
 */
function normalize(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

/**
 * Translate a single NO_READ_PATTERNS entry into a regular expression.
 *
 * Supported:
 * - `*`: matches any run of characters that does NOT cross a `/` boundary
 *   (i.e., one path segment).
 * - Literal segments.
 *
 * We anchor the pattern at a path-component boundary at the LEFT side
 * (start of string OR right after a `/`) to get path-suffix matching
 * without over-matching `.envelope.md` as `.env*`.
 */
function patternToRegex(pattern: string): RegExp {
  const lowered = pattern.toLowerCase();
  // Escape regex metacharacters except `*` which is our one wildcard.
  const escaped = lowered.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  // `**` crosses path boundaries; plain `*` stays within one segment.
  // Order matters: replace `**` first so it doesn't get mangled into
  // two single-segment wildcards.
  const withStars = escaped
    .replace(/\*\*/g, "__DOUBLESTAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLESTAR__/g, ".*");
  // The pattern may live at the start of the path OR after a `/`.
  // The pattern must run to end-of-string.
  return new RegExp(`(^|/)${withStars}$`);
}

const COMPILED: readonly RegExp[] = NO_READ_PATTERNS.map(patternToRegex);

/**
 * Returns true when `path` matches any no-read pattern. The check is
 * case-insensitive, path-suffix-based, and treats `\` as `/` for Windows
 * resilience.
 */
export function isNoRead(path: string): boolean {
  const n = normalize(path);
  for (const re of COMPILED) {
    if (re.test(n)) return true;
  }
  return false;
}
