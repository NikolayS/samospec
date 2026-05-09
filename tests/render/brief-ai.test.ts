// Copyright 2026 Nikolay Samokhvalov.

// Tests for the AI-generated rich HTML brief. The Adapter interface
// is mocked with a counting fake so we can assert call patterns
// (cache hit vs. miss, verifier retries, etc.) without reaching out
// to a real model.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  generateAiBrief,
  sanitizeHtml,
  type AiBriefInput,
} from "../../src/render/brief-ai.ts";
import type {
  Adapter,
  AskInput,
  AskOutput,
  CritiqueInput,
  CritiqueOutput,
  EffortLevel,
  ReviseInput,
  ReviseOutput,
} from "../../src/adapter/types.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "samospec-brief-ai-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface CallLog {
  count: number;
  lastPrompt: string;
  lastContext: string;
}

function makeAdapter(
  vendor: string,
  responses: readonly string[],
): { adapter: Adapter; log: CallLog } {
  const log: CallLog = { count: 0, lastPrompt: "", lastContext: "" };
  const adapter: Adapter = {
    vendor,
    detect: () =>
      Promise.resolve({
        installed: true as const,
        version: "test",
        path: "/usr/bin/" + vendor,
      }),
    auth_status: () => Promise.resolve({ authenticated: true }),
    supports_structured_output: () => true,
    supports_effort: (_l: EffortLevel) => true,
    models: () => Promise.resolve([]),
    ask: (input: AskInput): Promise<AskOutput> => {
      log.count += 1;
      log.lastPrompt = input.prompt;
      log.lastContext = input.context;
      const answer = responses[Math.min(log.count - 1, responses.length - 1)];
      return Promise.resolve({
        answer: answer ?? "",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
        effort_used: input.opts.effort,
      });
    },
    critique: (_i: CritiqueInput): Promise<CritiqueOutput> =>
      Promise.reject(new Error("not used")),
    revise: (_i: ReviseInput): Promise<ReviseOutput> =>
      Promise.reject(new Error("not used")),
  };
  return { adapter, log };
}

function baseInput(overrides: Partial<AiBriefInput> = {}): AiBriefInput {
  const { adapter: lead } = makeAdapter("claude", [
    "<!doctype html>\n<html><body>brief</body></html>",
  ]);
  const { adapter: verifier } = makeAdapter("codex", [
    '{"ok": true, "inventions": []}',
  ]);
  return {
    slug: "alpha",
    cwd: tmp,
    spec: "# Alpha\n\n## Goal\n\nGoal.\n",
    architecture: "{}",
    decisions: "# decisions\n",
    tldr: "# TL;DR\n",
    publishedVersion: "v0.2",
    publishedAt: "2026-05-09T11:55:00Z",
    lead,
    verifier,
    noCache: false,
    timeoutMs: 60_000,
    ...overrides,
  };
}

describe("generateAiBrief — happy path", () => {
  test("calls lead, then verifier, writes cache, returns html", async () => {
    const { adapter: lead, log: leadLog } = makeAdapter("claude", [
      "<!doctype html><html><body><h1>Refunds</h1></body></html>",
    ]);
    const { adapter: verifier, log: verifierLog } = makeAdapter("codex", [
      '{"ok": true, "inventions": []}',
    ]);
    const result = await generateAiBrief(baseInput({ lead, verifier }));
    expect(result.cached).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.verified).toBe(true);
    expect(result.inventions).toHaveLength(0);
    expect(result.html).toContain("<h1>Refunds</h1>");
    expect(leadLog.count).toBe(1);
    expect(verifierLog.count).toBe(1);
  });

  test("the lead's prompt embeds SPEC.md, architecture.json, decisions.md", async () => {
    const { adapter: lead, log: leadLog } = makeAdapter("claude", [
      "<!doctype html><html></html>",
    ]);
    const { adapter: verifier } = makeAdapter("codex", [
      '{"ok": true, "inventions": []}',
    ]);
    await generateAiBrief(
      baseInput({
        lead,
        verifier,
        spec: "# X\n\n## Goal\n\nspec body marker.\n",
        architecture: '{"nodes": ["arch marker"]}',
        decisions: "# decisions\n\n- decision marker\n",
      }),
    );
    expect(leadLog.lastContext).toContain("spec body marker");
    expect(leadLog.lastContext).toContain("arch marker");
    expect(leadLog.lastContext).toContain("decision marker");
  });

  test("the verifier's prompt embeds SPEC.md and the generated HTML", async () => {
    const { adapter: lead } = makeAdapter("claude", [
      "<!doctype html><html><body>generated body marker</body></html>",
    ]);
    const { adapter: verifier, log: verifierLog } = makeAdapter("codex", [
      '{"ok": true, "inventions": []}',
    ]);
    await generateAiBrief(
      baseInput({
        lead,
        verifier,
        spec: "# X\n\n## Goal\n\nspec body marker.\n",
      }),
    );
    expect(verifierLog.lastContext).toContain("spec body marker");
    expect(verifierLog.lastContext).toContain("generated body marker");
  });
});

describe("generateAiBrief — cache", () => {
  test("second run is a cache hit when spec is unchanged", async () => {
    const { adapter: lead, log: leadLog } = makeAdapter("claude", [
      "<!doctype html><html><body>v1</body></html>",
    ]);
    const { adapter: verifier } = makeAdapter("codex", [
      '{"ok": true, "inventions": []}',
    ]);
    const first = await generateAiBrief(baseInput({ lead, verifier }));
    expect(first.cached).toBe(false);
    expect(leadLog.count).toBe(1);

    const second = await generateAiBrief(baseInput({ lead, verifier }));
    expect(second.cached).toBe(true);
    expect(second.html).toBe(first.html);
    // Lead must not have been called again.
    expect(leadLog.count).toBe(1);
  });

  test("cache miss when spec content changes", async () => {
    const { adapter: lead, log: leadLog } = makeAdapter("claude", [
      "<!doctype html><html><body>v1</body></html>",
      "<!doctype html><html><body>v2</body></html>",
    ]);
    const { adapter: verifier } = makeAdapter("codex", [
      '{"ok": true, "inventions": []}',
      '{"ok": true, "inventions": []}',
    ]);
    await generateAiBrief(
      baseInput({ lead, verifier, spec: "# A\n\nbody A\n" }),
    );
    expect(leadLog.count).toBe(1);

    await generateAiBrief(
      baseInput({ lead, verifier, spec: "# B\n\nbody B (different)\n" }),
    );
    expect(leadLog.count).toBe(2);
  });

  test("--no-cache forces a fresh generation", async () => {
    const { adapter: lead, log: leadLog } = makeAdapter("claude", [
      "<!doctype html><html><body>v1</body></html>",
      "<!doctype html><html><body>v2</body></html>",
    ]);
    const { adapter: verifier } = makeAdapter("codex", [
      '{"ok": true, "inventions": []}',
      '{"ok": true, "inventions": []}',
    ]);
    await generateAiBrief(baseInput({ lead, verifier }));
    expect(leadLog.count).toBe(1);

    const second = await generateAiBrief(
      baseInput({ lead, verifier, noCache: true }),
    );
    expect(second.cached).toBe(false);
    expect(leadLog.count).toBe(2);
  });
});

describe("generateAiBrief — verifier behaviour", () => {
  test("retries when the verifier flags inventions, succeeds on retry", async () => {
    const { adapter: lead, log: leadLog } = makeAdapter("claude", [
      "<!doctype html><html><body>v1 with invented claim</body></html>",
      "<!doctype html><html><body>v2 cleaned up</body></html>",
    ]);
    const { adapter: verifier, log: verifierLog } = makeAdapter("codex", [
      '{"ok": false, "inventions": [{"claim": "invented X", "spec_says": "nothing"}]}',
      '{"ok": true, "inventions": []}',
    ]);
    const result = await generateAiBrief(baseInput({ lead, verifier }));
    expect(leadLog.count).toBe(2);
    expect(verifierLog.count).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.inventions).toHaveLength(0);
    expect(result.html).toContain("v2 cleaned up");
  });

  test("retry prompt includes the verifier's findings as guidance", async () => {
    const { adapter: lead, log: leadLog } = makeAdapter("claude", [
      "<!doctype html><html><body>v1 BAD</body></html>",
      "<!doctype html><html><body>v2 OK</body></html>",
    ]);
    const { adapter: verifier } = makeAdapter("codex", [
      '{"ok": false, "inventions": [{"claim": "made-up percentage 42%", "spec_says": "no number"}]}',
      '{"ok": true, "inventions": []}',
    ]);
    await generateAiBrief(baseInput({ lead, verifier }));
    // The second lead call's prompt must contain the retry guidance.
    expect(leadLog.lastPrompt).toContain("made-up percentage 42%");
    expect(leadLog.lastPrompt).toContain("no number");
  });

  test("after MAX_RETRY attempts still surfaces inventions in result", async () => {
    const inventionsResp =
      '{"ok": false, "inventions": [{"claim": "X", "spec_says": "Y"}]}';
    const { adapter: lead, log: leadLog } = makeAdapter("claude", [
      "<!doctype html><html><body>a</body></html>",
      "<!doctype html><html><body>b</body></html>",
      "<!doctype html><html><body>c</body></html>",
    ]);
    const { adapter: verifier, log: verifierLog } = makeAdapter("codex", [
      inventionsResp,
      inventionsResp,
      inventionsResp,
    ]);
    const result = await generateAiBrief(baseInput({ lead, verifier }));
    expect(leadLog.count).toBe(3);
    expect(verifierLog.count).toBe(3);
    expect(result.attempts).toBe(3);
    expect(result.inventions).toHaveLength(1);
    expect(result.inventions[0]?.claim).toBe("X");
    // File still written so user can review.
    expect(result.html).toContain("<body>c</body>");
  });

  test("--no-verify (verifier=null) skips the verification pass entirely", async () => {
    const { adapter: lead, log: leadLog } = makeAdapter("claude", [
      "<!doctype html><html><body>x</body></html>",
    ]);
    const result = await generateAiBrief(baseInput({ lead, verifier: null }));
    expect(leadLog.count).toBe(1);
    expect(result.verified).toBe(false);
    expect(result.inventions).toHaveLength(0);
  });

  test("verifier returning malformed JSON is treated as 'inventions found'", async () => {
    const { adapter: lead } = makeAdapter("claude", [
      "<!doctype html><html><body>x</body></html>",
      "<!doctype html><html><body>y</body></html>",
      "<!doctype html><html><body>z</body></html>",
    ]);
    const { adapter: verifier } = makeAdapter("codex", [
      "this is not JSON",
      "still not JSON",
      "really not JSON",
    ]);
    const result = await generateAiBrief(baseInput({ lead, verifier }));
    expect(result.inventions.length).toBeGreaterThan(0);
  });

  test("verifier returning fenced ```json``` block is parsed", async () => {
    const { adapter: lead } = makeAdapter("claude", [
      "<!doctype html><html><body>x</body></html>",
    ]);
    const { adapter: verifier } = makeAdapter("codex", [
      '```json\n{"ok": true, "inventions": []}\n```',
    ]);
    const result = await generateAiBrief(baseInput({ lead, verifier }));
    expect(result.inventions).toHaveLength(0);
    expect(result.attempts).toBe(1);
  });
});

describe("generateAiBrief — HTML extraction from model response", () => {
  test("unwraps ```html ... ``` fences", async () => {
    const { adapter: lead } = makeAdapter("claude", [
      "Here is your brief:\n\n```html\n<!doctype html><html><body>x</body></html>\n```\n",
    ]);
    const result = await generateAiBrief(baseInput({ lead, verifier: null }));
    expect(result.html.startsWith("<!doctype html>")).toBe(true);
    expect(result.html).not.toContain("Here is your brief");
    expect(result.html).not.toContain("```");
  });

  test("accepts naked HTML starting with <!doctype>", async () => {
    const { adapter: lead } = makeAdapter("claude", [
      "<!DOCTYPE html>\n<html><body>raw</body></html>",
    ]);
    const result = await generateAiBrief(baseInput({ lead, verifier: null }));
    expect(result.html).toContain("<body>raw</body>");
  });

  test("accepts naked HTML starting with <html>", async () => {
    const { adapter: lead } = makeAdapter("claude", [
      "<html><body>no doctype</body></html>",
    ]);
    const result = await generateAiBrief(baseInput({ lead, verifier: null }));
    expect(result.html).toContain("<body>no doctype</body>");
  });

  test("wraps a fragment in a minimal scaffold so output is always valid HTML", async () => {
    const { adapter: lead } = makeAdapter("claude", ["<p>just a fragment</p>"]);
    const result = await generateAiBrief(baseInput({ lead, verifier: null }));
    expect(result.html).toContain("<!doctype html>");
    expect(result.html).toContain("<p>just a fragment</p>");
  });
});

describe("sanitizeHtml — XSS scrubbing", () => {
  test("strips <script> tags with bodies", () => {
    const out = sanitizeHtml(
      "<p>before</p><script>alert(1)</script><p>after</p>",
    );
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("<p>before</p>");
    expect(out).toContain("<p>after</p>");
  });

  test("strips self-closing or empty <script> tags", () => {
    const out = sanitizeHtml('<script src="evil.js"/><p>after</p>');
    expect(out).not.toContain("<script");
    expect(out).toContain("<p>after</p>");
  });

  test("strips <iframe>, <object>, <embed>", () => {
    const out = sanitizeHtml(
      '<iframe src="x"></iframe><object></object><embed/>',
    );
    expect(out).not.toContain("<iframe");
    expect(out).not.toContain("<object");
    expect(out).not.toContain("<embed");
  });

  test("strips on*= event handlers (double, single, unquoted)", () => {
    const a = sanitizeHtml('<div onclick="bad()">x</div>');
    expect(a).not.toContain("onclick");
    const b = sanitizeHtml("<img onerror='boom()'>");
    expect(b).not.toContain("onerror");
    const c = sanitizeHtml("<img onload=fire>");
    expect(c).not.toContain("onload");
  });

  test("neutralises javascript: URLs in href / src", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain('href="javascript:');
    expect(out).toContain("blocked:");
  });

  test("preserves benign content untouched", () => {
    const safe = '<svg><circle cx="5" cy="5" r="3"/></svg><p>fine</p>';
    expect(sanitizeHtml(safe)).toBe(safe);
  });
});

describe("generateAiBrief — sanitization wires through end-to-end", () => {
  test("model output containing <script> is scrubbed before write", async () => {
    const { adapter: lead } = makeAdapter("claude", [
      "<!doctype html><html><body><script>alert('xss')</script><p>ok</p></body></html>",
    ]);
    const result = await generateAiBrief(baseInput({ lead, verifier: null }));
    expect(result.html).not.toContain("<script>");
    expect(result.html).not.toContain("alert");
    expect(result.html).toContain("<p>ok</p>");
  });

  test("cache file is the sanitised HTML, not the raw model output", async () => {
    const { adapter: lead } = makeAdapter("claude", [
      "<!doctype html><html><body><script>x</script>safe</body></html>",
    ]);
    await generateAiBrief(baseInput({ lead, verifier: null }));
    // Find the cache file
    const cacheDir = path.join(tmp, ".samo", "cache", "brief");
    expect(existsSync(cacheDir)).toBe(true);
    const files = readdirSync(cacheDir);
    expect(files.length).toBe(1);
    const cached = readFileSync(path.join(cacheDir, files[0] ?? ""), "utf8");
    expect(cached).not.toContain("<script>");
    expect(cached).toContain("safe");
  });
});
