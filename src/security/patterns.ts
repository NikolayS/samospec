// Copyright 2026 Nikolay Samokhvalov.

/**
 * Redaction regex corpus (SPEC §9). Patterns intentionally narrow — the
 * goal is high precision on real credentials with no false positives on
 * spec prose (`v1.2.3`, `foo.bar.baz`, `example.com.au`, paths).
 *
 * Sourced from the gitleaks + truffleHog rule sets. Kept deliberately
 * small: `samospec` does not aim to replace those scanners; SPEC §14
 * explicitly recommends running them on sensitive repos. This corpus is
 * the "best-effort" pass applied before writing transcripts and the
 * signal that drives the `doctor` entropy warning.
 *
 * DO NOT embed real credentials in doc comments. If a pattern's shape
 * needs illustrating, use EXAMPLE / example as filler.
 */

export interface RedactionPattern {
  /** Machine-readable kind emitted in the `<redacted:kind>` placeholder. */
  readonly kind: string;
  /** Human-readable label for log output. */
  readonly label: string;
  /**
   * Regex that matches the secret shape. MUST be a global regex (`g`)
   * so `String.prototype.replace` redacts every occurrence, not just
   * the first.
   */
  readonly regex: RegExp;
}

// Shared body character classes.
const ALNUM = "A-Za-z0-9";
const ALNUM_UNDERSCORE_DASH = "A-Za-z0-9_-";
const UPPER_ALNUM = "A-Z0-9";

export const PATTERNS: readonly RedactionPattern[] = [
  // AWS long-term access key ID: AKIA + 16 uppercase-alnum.
  {
    kind: "aws_akia",
    label: "AWS access key ID",
    regex: new RegExp(`AKIA[${UPPER_ALNUM}]{16}`, "g"),
  },
  // AWS STS/temporary access key ID: ASIA + 16 uppercase-alnum.
  {
    kind: "aws_asia",
    label: "AWS STS access key ID",
    regex: new RegExp(`ASIA[${UPPER_ALNUM}]{16}`, "g"),
  },
  // OpenAI project key: `sk-proj-` + 20+ alnum.
  // NOTE: The project-key rule is checked BEFORE the generic `sk-` rule
  // so the longer prefix wins; see `patternsInDeclaredOrder()` guarantee
  // documented on PATTERNS.
  {
    kind: "openai_sk_proj",
    label: "OpenAI project key",
    regex: new RegExp(`sk-proj-[${ALNUM}]{20,}`, "g"),
  },
  // OpenAI generic API key: `sk-` + 20+ alnum. A lookahead excludes the
  // `proj-` variant so the two rules don't both fire on the same match.
  {
    kind: "openai_sk",
    label: "OpenAI API key",
    regex: new RegExp(`sk-(?!proj-)[${ALNUM}]{20,}`, "g"),
  },
  // Stripe live/test keys: sk_live_ / sk_test_ + 24+ alnum.
  {
    kind: "stripe_live",
    label: "Stripe live key",
    regex: new RegExp(`sk_live_[${ALNUM}]{24,}`, "g"),
  },
  {
    kind: "stripe_test",
    label: "Stripe test key",
    regex: new RegExp(`sk_test_[${ALNUM}]{24,}`, "g"),
  },
  // GitHub tokens: ghp_ / gho_ / ghs_ + exactly 36 alnum.
  {
    kind: "github_ghp",
    label: "GitHub personal access token",
    regex: new RegExp(`ghp_[${ALNUM}]{36}`, "g"),
  },
  {
    kind: "github_gho",
    label: "GitHub OAuth token",
    regex: new RegExp(`gho_[${ALNUM}]{36}`, "g"),
  },
  {
    kind: "github_ghs",
    label: "GitHub server-to-server token",
    regex: new RegExp(`ghs_[${ALNUM}]{36}`, "g"),
  },
  // GitLab personal access token: glpat- + 20+ alnum/underscore/dash.
  {
    kind: "gitlab_glpat",
    label: "GitLab personal access token",
    regex: new RegExp(`glpat-[${ALNUM_UNDERSCORE_DASH}]{20,}`, "g"),
  },
  // JWT (tightened): eyJ + three dot-separated base64url segments,
  // each at least 10 chars. Deliberately narrower than the v0.4 spec
  // draft's overbroad `X.Y.Z` form — SPEC §9 specifically calls out
  // `v1.2.3` / `foo.bar.baz` / `example.com.au` as must-not-match.
  {
    kind: "jwt",
    label: "JSON web token",
    regex: new RegExp(
      `eyJ[${ALNUM_UNDERSCORE_DASH}]{10,}\\.` +
        `[${ALNUM_UNDERSCORE_DASH}]{10,}\\.` +
        `[${ALNUM_UNDERSCORE_DASH}]{10,}`,
      "g",
    ),
  },
  // Slack tokens: xox[bpoar]- + 10+ alnum/dash body.
  {
    kind: "slack",
    label: "Slack token",
    regex: new RegExp(`xox[bpoar]-[${ALNUM}-]{10,}`, "g"),
  },
  // Google API key: AIza + 35 alnum/underscore/dash.
  {
    kind: "google_aiza",
    label: "Google API key",
    regex: new RegExp(`AIza[${ALNUM_UNDERSCORE_DASH}]{35}`, "g"),
  },
];
