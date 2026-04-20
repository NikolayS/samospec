// Copyright 2026 Nikolay Samokhvalov.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import path from "node:path";

import { redact } from "../../src/security/redact.ts";
import { PATTERNS } from "../../src/security/patterns.ts";

const FIXTURES_DIR = path.join(
  import.meta.dirname ?? __dirname,
  "..",
  "fixtures",
  "redaction",
);

interface TaggedSecret {
  readonly kind: string;
  readonly value: string;
}

function parseKnown(): readonly TaggedSecret[] {
  const raw = readFileSync(path.join(FIXTURES_DIR, "known.txt"), "utf8");
  const out: TaggedSecret[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    // Format: kind\tprefix\tbody. The probe string is built here so
    // the committed fixture never contains a full secret-shaped token
    // on a single scannable line (keeps GitHub push-protection quiet).
    const [kind, prefix, body] = line.split("\t");
    if (kind === undefined || prefix === undefined || body === undefined) {
      continue;
    }
    out.push({ kind, value: `${prefix}${body}` });
  }
  return out;
}

function parseSafe(): readonly string[] {
  const raw = readFileSync(path.join(FIXTURES_DIR, "safe.txt"), "utf8");
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    out.push(line);
  }
  return out;
}

// -------- pattern corpus --------

describe("security/patterns — pattern corpus coverage (SPEC §9)", () => {
  const kinds = new Set(PATTERNS.map((p) => p.kind));

  const required = [
    "aws_akia",
    "aws_asia",
    "openai_sk",
    "openai_sk_proj",
    "github_ghp",
    "github_gho",
    "github_ghs",
    "gitlab_glpat",
    "jwt",
    "slack",
    "stripe_live",
    "stripe_test",
    "google_aiza",
  ] as const;

  for (const k of required) {
    test(`corpus includes '${k}'`, () => {
      expect(kinds.has(k)).toBe(true);
    });
  }

  test("every pattern is a global regex (so replace() hits every match)", () => {
    for (const p of PATTERNS) {
      expect(p.regex.flags).toContain("g");
    }
  });
});

// -------- positive (Direction A) — each tagged fixture is redacted --------

describe("security/redact — positive direction (SPEC §13 item 7, A)", () => {
  const corpus = parseKnown();

  for (const row of corpus) {
    test(`redacts ${row.kind}: '${row.value.slice(0, 12)}...'`, () => {
      const out = redact(row.value);
      expect(out).not.toBe(row.value);
      expect(out).toContain("<redacted:");
    });
  }

  test("redacts a secret embedded in surrounding prose", () => {
    for (const row of corpus) {
      const prose = `see the leaked value ${row.value} in the log`;
      const out = redact(prose);
      expect(out).not.toContain(row.value);
      expect(out).toContain("<redacted:");
      expect(out).toContain("see the leaked value");
      expect(out).toContain("in the log");
    }
  });

  test("redacts multiple secrets on the same line", () => {
    // Assembled from fragments so the literal string never appears
    // verbatim in the committed source.
    const ak = "AKIA" + "EXAMPLEKEY12345X";
    const gh = "ghp_" + "ExampleExampleExampleExampleExample12";
    const line = `aws=${ak} gh=${gh}`;
    const out = redact(line);
    expect(out).not.toContain(ak);
    expect(out).not.toContain(gh);
    // Two distinct redactions.
    const matches = out.match(/<redacted:[a-z_]+>/g) ?? [];
    expect(matches.length).toBe(2);
  });

  test("JWT pattern covers the tightened eyJ... form", () => {
    const jwt =
      "eyJ" +
      "EXAMPLEexample1" +
      ".EXAMPLEexample12345" +
      ".EXAMPLEsignature67";
    const out = redact(jwt);
    expect(out).toContain("<redacted:jwt>");
  });
});

// -------- negative (Direction B) — safe corpus passes through --------

describe("security/redact — negative direction (SPEC §13 item 7, B)", () => {
  const safe = parseSafe();

  for (const s of safe) {
    test(`leaves safe string unchanged: '${s.slice(0, 40)}'`, () => {
      expect(redact(s)).toBe(s);
    });
  }

  // The two classic traps called out in SPEC §9.
  test("v1.2.3 must NOT match the tightened JWT regex", () => {
    expect(redact("v1.2.3")).toBe("v1.2.3");
  });

  test("foo.bar.baz must NOT match the tightened JWT regex", () => {
    expect(redact("foo.bar.baz")).toBe("foo.bar.baz");
  });

  test("example.com.au must NOT match the tightened JWT regex", () => {
    expect(redact("example.com.au")).toBe("example.com.au");
  });

  test("path-like src/foo/bar.ts must NOT trigger anything", () => {
    expect(redact("src/foo/bar.ts")).toBe("src/foo/bar.ts");
  });
});

// -------- property tests --------

// ASCII character set that explicitly excludes every pattern prefix AND
// the dot, so random strings can't accidentally build `AKIA`, `ghp_`,
// `eyJ`, etc. inside them.
const SAFE_ASCII_CHARS =
  "bcdfhijlmnpqrtuvwyzBCDFHIJLMNPQRTUVWYZ0123456789 -=+*?!()[]{}";

const safeCharArb = fc.constantFrom(...SAFE_ASCII_CHARS.split(""));
const safeStringArb = fc
  .array(safeCharArb, { minLength: 0, maxLength: 200 })
  .map((chars) => chars.join(""));

describe("security/redact — property-based (SPEC §13 item 7)", () => {
  test("Direction A: generated matching strings are always redacted", () => {
    // Generate synthetic matches for each kind by sampling body chars from
    // the pattern's alphabet. The length is drawn loosely but always past
    // the regex minimum so a match is guaranteed.
    const alnum = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const upperAlnum = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    const aws = fc
      .stringMatching(new RegExp(`^[${upperAlnum}]{16}$`))
      .map((s) => `AKIA${s}`);
    const openai = fc
      .stringMatching(new RegExp(`^[${alnum}]{30,40}$`))
      .map((s) => `sk-${s}`);
    const github = fc
      .stringMatching(new RegExp(`^[${alnum}]{36}$`))
      .map((s) => `ghp_${s}`);
    const stripe = fc
      .stringMatching(new RegExp(`^[${alnum}]{30,40}$`))
      .map((s) => `sk_live_${s}`);

    const generators = [aws, openai, github, stripe];

    for (const gen of generators) {
      fc.assert(
        fc.property(gen, (secret) => {
          const out = redact(secret);
          expect(out).toContain("<redacted:");
          expect(out).not.toContain(secret);
        }),
        { numRuns: 200 },
      );
    }
  });

  test(
    "Direction B: random safe strings are identity under redact (N≥1000)",
    () => {
      fc.assert(
        fc.property(safeStringArb, (s) => {
          expect(redact(s)).toBe(s);
        }),
        { numRuns: 1000 },
      );
    },
    15_000,
  );

  test("Direction B: random version-number-shaped strings are identity", () => {
    const versionArb = fc
      .tuple(
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 99 }),
        fc.integer({ min: 0, max: 99 }),
      )
      .map(([a, b, c]) => `v${a}.${b}.${c}`);
    fc.assert(
      fc.property(versionArb, (v) => {
        expect(redact(v)).toBe(v);
      }),
      { numRuns: 500 },
    );
  });

  test("Direction B: random dotted-triple identifiers are identity", () => {
    const tokenArb = fc.stringMatching(/^[a-z]{3,10}$/);
    const tripleArb = fc
      .tuple(tokenArb, tokenArb, tokenArb)
      .map(([a, b, c]) => `${a}.${b}.${c}`);
    fc.assert(
      fc.property(tripleArb, (t) => {
        expect(redact(t)).toBe(t);
      }),
      { numRuns: 500 },
    );
  });

  test("idempotence: redact(redact(s)) === redact(s)", () => {
    fc.assert(
      fc.property(safeStringArb, (s) => {
        const once = redact(s);
        expect(redact(once)).toBe(once);
      }),
      { numRuns: 300 },
    );
  });
});

// -------- SPEC self-scan (the spec mentions patterns literally) --------

describe("security/redact — SPEC prose must pass through unchanged", () => {
  test("patterns appearing as prose in SPEC.md do not collide with real matches", () => {
    // Representative safe prose from SPEC §9. Even though the words `AKIA`
    // and `ghp_` appear, none of these strings should match a shape.
    const snippets = [
      "AWS: `AKIA[0-9A-Z]{16}`, `ASIA[0-9A-Z]{16}`.",
      "OpenAI-family: `sk-[A-Za-z0-9]{20,}`.",
      "GitHub: `ghp_[A-Za-z0-9]{36}`.",
      "JWT (tightened): `eyJ[A-Za-z0-9_-]{10,}` form.",
      "Examples of safe prose: v1.2.3, foo.bar.baz, example.com.au.",
    ];
    for (const s of snippets) {
      expect(redact(s)).toBe(s);
    }
  });
});
