import { describe, expect, test } from "bun:test";
import {
  MAX_BODY_BYTES,
  MAX_TITLE,
  parsePublishPayload,
} from "../src/lib/publish-validate";

describe("parsePublishPayload", () => {
  const validBody = "# hi\n\nspec";

  test("accepts a minimal valid payload", () => {
    const r = parsePublishPayload({ title: "hello", body_md: validBody });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.title).toBe("hello");
      expect(r.value.bodyMd).toBe(validBody);
      expect(r.value.code).toBe(null);
    }
  });

  test("strips control characters from title", () => {
    const r = parsePublishPayload({
      title: "hi\tthere\n\rworld\x00!",
      body_md: validBody,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.title).toBe("hi there world !");
  });

  test("rejects empty title", () => {
    const r = parsePublishPayload({ title: "   ", body_md: validBody });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_title");
  });

  test("rejects title longer than MAX_TITLE", () => {
    const r = parsePublishPayload({
      title: "x".repeat(MAX_TITLE + 1),
      body_md: validBody,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_title");
  });

  test("rejects oversize body", () => {
    const r = parsePublishPayload({
      title: "ok",
      body_md: "x".repeat(MAX_BODY_BYTES + 1),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_body");
  });

  test("rejects empty body", () => {
    const r = parsePublishPayload({ title: "ok", body_md: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_body");
  });

  test("rejects non-object payload", () => {
    const r = parsePublishPayload("nope");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("invalid_json");
  });

  test('code "auto" parses to auto', () => {
    const r = parsePublishPayload({
      title: "ok",
      body_md: validBody,
      code: "auto",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.code).toBe("auto");
  });

  test('code "none" parses to null', () => {
    const r = parsePublishPayload({
      title: "ok",
      body_md: validBody,
      code: "none",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.code).toBe(null);
  });

  test("caller-supplied code is trimmed and uppercased", () => {
    const r = parsePublishPayload({
      title: "ok",
      body_md: validBody,
      code: " abc123 ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.code).toBe("ABC123");
  });

  test("rejects caller-supplied code with bad characters or length", () => {
    for (const bad of ["ab", "ABC", "!!!!!!", "x".repeat(13)]) {
      const r = parsePublishPayload({
        title: "ok",
        body_md: validBody,
        code: bad,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe("invalid_code");
    }
  });
});
