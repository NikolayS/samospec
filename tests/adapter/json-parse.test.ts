// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";

import { preParseJson } from "../../src/adapter/json-parse.ts";

describe("preParseJson (SPEC §7 deterministic three-step)", () => {
  test("step 1: clean JSON parses on first try", () => {
    const raw = '{"ready":true,"rationale":"looks good"}';

    const result = preParseJson(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ ready: true, rationale: "looks good" });
      expect(result.stripped).toBe(false);
    }
  });

  test("step 1: clean array parses on first try", () => {
    const raw = "[1, 2, 3]";

    const result = preParseJson(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([1, 2, 3]);
      expect(result.stripped).toBe(false);
    }
  });

  test("step 2: fenced with ```json\\n prefix strips and retries", () => {
    const raw = '```json\n{"ready":true,"rationale":"ok"}\n```';

    const result = preParseJson(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ ready: true, rationale: "ok" });
      expect(result.stripped).toBe(true);
    }
  });

  test("step 2: fenced with ```\\n prefix (no lang) strips and retries", () => {
    const raw = '```\n{"ready":false,"rationale":"nope"}\n```';

    const result = preParseJson(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ ready: false, rationale: "nope" });
      expect(result.stripped).toBe(true);
    }
  });

  test("step 2: trailing fence may be followed by whitespace", () => {
    const raw = '```json\n{"a":1}\n```\n\n  \t';

    const result = preParseJson(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ a: 1 });
      expect(result.stripped).toBe(true);
    }
  });

  test("step 2: without leading fence even if trailing fence present, schema_violation", () => {
    const raw = '{"broken":}\n```';

    const result = preParseJson(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("schema_violation");
    }
  });

  test("step 2: without trailing fence even if leading fence present, schema_violation", () => {
    const raw = '```json\n{"broken":}';

    const result = preParseJson(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("schema_violation");
    }
  });

  test("step 3: double-fenced content fails (we strip ONE pair only)", () => {
    // After stripping one pair, inside is still fenced, which is not JSON.
    const raw = '```\n```json\n{"a":1}\n```\n```';

    const result = preParseJson(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("schema_violation");
    }
  });

  test("step 3: malformed JSON without fences -> schema_violation", () => {
    const raw = "{not json at all";

    const result = preParseJson(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("schema_violation");
    }
  });

  test("step 3: malformed JSON inside fences -> schema_violation", () => {
    const raw = "```json\n{not,: json}\n```";

    const result = preParseJson(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("schema_violation");
    }
  });

  test("triple backticks inside string values are fine when outer is clean JSON", () => {
    // Clean JSON whose value happens to contain ``` — step 1 succeeds,
    // we never enter fence-stripping.
    const raw = JSON.stringify({ note: "use ```js blocks please```" });

    const result = preParseJson(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ note: "use ```js blocks please```" });
      expect(result.stripped).toBe(false);
    }
  });

  test("fenced JSON whose content contains triple-backticks in a string value parses", () => {
    const inner = JSON.stringify({ note: "prefer ```ts" });
    const raw = "```json\n" + inner + "\n```";

    const result = preParseJson(raw);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ note: "prefer ```ts" });
      expect(result.stripped).toBe(true);
    }
  });

  test("empty string -> schema_violation", () => {
    const result = preParseJson("");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("schema_violation");
    }
  });

  test("only whitespace -> schema_violation", () => {
    const result = preParseJson("   \n\t  ");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("schema_violation");
    }
  });

  test("no regex multi-fence stripping: only exactly one pair is removed", () => {
    // Even if the result after one strip would itself be valid-looking
    // markdown but not JSON, we must return schema_violation.
    const raw = "```\n```\n{}\n```\n```";

    const result = preParseJson(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("schema_violation");
    }
  });

  test("leading ```markdown (non-json, non-empty-lang) does not strip", () => {
    // Only ```json\n or ```\n fences count per SPEC §7.
    const raw = '```markdown\n{"a":1}\n```';

    const result = preParseJson(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("schema_violation");
    }
  });

  test("carries the underlying JSON.parse error message through", () => {
    const result = preParseJson("{bad json");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("schema_violation");
      expect(typeof result.error.message).toBe("string");
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });
});
