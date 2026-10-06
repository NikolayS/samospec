// Pure validation for /api/publish. Extracted so it can be unit-tested
// without standing up a database or HTTP server.

export const MAX_BODY_BYTES = 1_048_576; // 1 MiB
export const MAX_TITLE = 200;

export type ParsedPublish = {
  title: string;
  bodyMd: string;
  // null = public spec; "auto" = server generates a code;
  // string = caller-supplied code, already trimmed + upper-cased.
  code: null | "auto" | string;
};

export type ParseResult =
  | { ok: true; value: ParsedPublish }
  | {
      ok: false;
      error:
        | "invalid_title"
        | "invalid_body"
        | "invalid_code"
        | "invalid_json";
    };

export function parsePublishPayload(raw: unknown): ParseResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "invalid_json" };
  }
  const payload = raw as Record<string, unknown>;

  // eslint-disable-next-line no-control-regex
  const cleanTitle = String(payload["title"] ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleanTitle || cleanTitle.length > MAX_TITLE) {
    return { ok: false, error: "invalid_title" };
  }

  const bodyMd = String(payload["body_md"] ?? "");
  if (!bodyMd || new Blob([bodyMd]).size > MAX_BODY_BYTES) {
    return { ok: false, error: "invalid_body" };
  }

  let code: ParsedPublish["code"] = null;
  const rawCode = payload["code"];
  if (rawCode === "auto") {
    code = "auto";
  } else if (typeof rawCode === "string" && rawCode !== "none") {
    const literal = rawCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(literal)) {
      return { ok: false, error: "invalid_code" };
    }
    code = literal;
  }

  return { ok: true, value: { title: cleanTitle, bodyMd, code } };
}
