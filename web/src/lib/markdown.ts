import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { async: false }) as string;
  return sanitizeHtml(raw, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags,
      "img",
      "h1",
      "h2",
      "details",
      "summary",
      "pre",
      "code",
    ],
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "title", "width", "height"],
      // Only language classes from fenced code blocks ("language-ts" etc.)
      // are allowed; nothing on other tags.
      code: ["class"],
      pre: ["class"],
    },
    allowedClasses: {
      code: [/^language-[a-z0-9_-]+$/i],
      pre: [/^language-[a-z0-9_-]+$/i],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: {
      img: ["http", "https", "data"],
    },
    transformTags: {
      a: (_tag, attrs) => ({
        tagName: "a",
        attribs: {
          ...attrs,
          rel: "noopener noreferrer",
          target: "_blank",
        },
      }),
    },
  });
}
