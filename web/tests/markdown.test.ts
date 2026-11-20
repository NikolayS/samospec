import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../src/lib/markdown";

describe("renderMarkdown sanitizer", () => {
  test("renders normal markdown", () => {
    const html = renderMarkdown("# title\n\nhello **world**");
    expect(html).toContain("<h1>");
    expect(html).toContain("<strong>world</strong>");
  });

  test("strips <script> tags", () => {
    const html = renderMarkdown(
      "before<script>alert(1)</script>after",
    ).toLowerCase();
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
  });

  test("strips <iframe> tags", () => {
    const html = renderMarkdown(
      "x<iframe src='https://evil'></iframe>y",
    ).toLowerCase();
    expect(html).not.toContain("<iframe");
  });

  test("rejects javascript: hrefs", () => {
    const html = renderMarkdown(
      "[click](javascript:alert(1))",
    ).toLowerCase();
    expect(html).not.toContain("javascript:");
  });

  test("anchors get rel and target attributes", () => {
    const html = renderMarkdown("[link](https://example.com)");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  test("drops wildcard id/class attributes", () => {
    const html = renderMarkdown(
      '<p id="x" class="y">hi</p>',
    ).toLowerCase();
    expect(html).not.toContain('id="x"');
    expect(html).not.toContain('class="y"');
  });

  test("allows language- class on code blocks", () => {
    const html = renderMarkdown("```ts\nconst x = 1;\n```");
    expect(html).toContain("language-ts");
  });

  test("drops non-language classes on code blocks", () => {
    const html = renderMarkdown('<code class="evil">x</code>');
    expect(html).not.toContain('class="evil"');
  });
});
