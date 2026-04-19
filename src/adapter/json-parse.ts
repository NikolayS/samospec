// Copyright 2026 Nikolay Samokhvalov.

// SPEC §7: deterministic three-step JSON pre-parser.
// 1. JSON.parse(raw) — success path.
// 2. On failure, if raw has leading ```json\n OR ```\n AND trailing ```
//    (optional trailing whitespace), strip EXACTLY ONE pair and retry.
// 3. On second failure, schema_violation.
//
// No regex-based multi-fence stripping. No substring search inside the
// payload. Only boundary checks on the raw string.

export interface SchemaViolation {
  readonly kind: "schema_violation";
  readonly message: string;
}

export type PreParseResult<T = unknown> =
  | { readonly ok: true; readonly value: T; readonly stripped: boolean }
  | { readonly ok: false; readonly error: SchemaViolation };

const FENCE_JSON_PREFIX = "```json\n";
const FENCE_BARE_PREFIX = "```\n";
const FENCE_SUFFIX = "```";

function tryParse(
  raw: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function stripOneFencePair(raw: string): string | null {
  // Leading: exactly ```json\n OR ```\n.
  let prefixLen: number;
  if (raw.startsWith(FENCE_JSON_PREFIX)) {
    prefixLen = FENCE_JSON_PREFIX.length;
  } else if (raw.startsWith(FENCE_BARE_PREFIX)) {
    prefixLen = FENCE_BARE_PREFIX.length;
  } else {
    return null;
  }

  // Trailing: ``` optionally followed by whitespace (spaces, tabs, \n).
  // We find the end by right-trimming whitespace first.
  const trimmedEnd = raw.replace(/\s+$/u, "");
  if (!trimmedEnd.endsWith(FENCE_SUFFIX)) {
    return null;
  }
  const suffixStart = trimmedEnd.length - FENCE_SUFFIX.length;
  if (suffixStart < prefixLen) {
    // The whole thing is just the fence markers.
    return null;
  }
  // Require a newline immediately before the trailing ``` so we don't
  // accept "```json\n{...}```" with no body separator. We allow the
  // common case where the inner payload ends with a newline.
  if (trimmedEnd[suffixStart - 1] !== "\n") {
    return null;
  }
  return trimmedEnd.slice(prefixLen, suffixStart - 1);
}

export function preParseJson<T = unknown>(raw: string): PreParseResult<T> {
  // Step 1.
  const first = tryParse(raw);
  if (first.ok) {
    return { ok: true, value: first.value as T, stripped: false };
  }

  // Step 2.
  const stripped = stripOneFencePair(raw);
  if (stripped === null) {
    return {
      ok: false,
      error: { kind: "schema_violation", message: first.message },
    };
  }
  const second = tryParse(stripped);
  if (second.ok) {
    return { ok: true, value: second.value as T, stripped: true };
  }

  // Step 3.
  return {
    ok: false,
    error: { kind: "schema_violation", message: second.message },
  };
}
