// Copyright 2026 Nikolay Samokhvalov.

// SPEC §11 subscription-auth escape detection.
//
// Claude CLI supports two auth modes:
//   1. API key via ANTHROPIC_API_KEY — token counts available.
//   2. Subscription login (Claude Max/Pro) — CLI stores a subscription
//      token in the OS keychain; token counts are NOT reported.
//
// Heuristic for `auth_status().subscription_auth`:
//   - If the adapter is authenticated AND no vendor API-key env var
//     carries a non-empty value, treat as subscription auth.
//   - Non-authenticated -> subscription_auth is false (not meaningful).
//   - Non-Claude vendors (Codex, etc.) do not currently offer
//     subscription auth; we return false. When a new vendor ships
//     subscription auth, add its keys here.
//
// The real Claude adapter will layer additional checks in Sprint 2
// (e.g. probing `claude auth status --json`); this module is the
// deterministic env-var heuristic shared by the adapter and `doctor`.

export interface DetectSubscriptionAuthInput {
  readonly vendor: string;
  readonly authenticated: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const API_KEY_ENV_VARS_BY_VENDOR: Readonly<Record<string, readonly string[]>> =
  {
    claude: ["ANTHROPIC_API_KEY"],
    // Codex / OpenAI: no subscription-auth path exists at time of writing.
    codex: [],
  };

export function detectSubscriptionAuth(
  input: DetectSubscriptionAuthInput,
): boolean {
  if (!input.authenticated) {
    return false;
  }
  const keys = API_KEY_ENV_VARS_BY_VENDOR[input.vendor] ?? [];
  if (keys.length === 0) {
    return false;
  }
  const hasAnyApiKey = keys.some((k) => {
    const v = input.env[k];
    return typeof v === "string" && v.length > 0;
  });
  return !hasAnyApiKey;
}
