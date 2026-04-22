// Copyright 2026 Nikolay Samokhvalov.

// SPEC §3 + Issue #107 — red-first schema tests for architecture.json.
// The schema is the canonical machine-readable representation; the
// ASCII renderer and SPEC.md injection both consume it. Tests here
// cover the Zod shape + cross-field refinements (unique ids, edge
// endpoint resolution, group membership, zero-node legality).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ARCHITECTURE_EDGE_KINDS,
  ARCHITECTURE_NODE_KINDS,
  architectureSchema,
  emptyArchitecture,
  parseArchitecture,
} from "../../src/state/architecture.ts";

const FIXTURE_DIR = path.resolve(
  import.meta.dir,
  "..",
  "fixtures",
  "architecture",
);

function loadFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, name), "utf8"),
  ) as unknown;
}

describe("architectureSchema — constant tables", () => {
  test("node kinds are exactly { external, component, datastore, boundary }", () => {
    expect([...ARCHITECTURE_NODE_KINDS]).toEqual([
      "external",
      "component",
      "datastore",
      "boundary",
    ]);
  });

  test("edge kinds are exactly { call, data, control }", () => {
    expect([...ARCHITECTURE_EDGE_KINDS]).toEqual(["call", "data", "control"]);
  });
});

describe("architectureSchema — accepts valid fixtures", () => {
  test("trivial 2-node graph parses", () => {
    const result = architectureSchema.safeParse(loadFixture("trivial.json"));
    expect(result.success).toBe(true);
  });

  test("grouped fixture parses (edge resolves to a group id)", () => {
    const result = architectureSchema.safeParse(loadFixture("grouped.json"));
    expect(result.success).toBe(true);
  });

  test("oversized fixture parses (20 nodes + 2 groups)", () => {
    const result = architectureSchema.safeParse(loadFixture("oversized.json"));
    expect(result.success).toBe(true);
  });

  test("zero-node fixture parses (valid placeholder)", () => {
    const result = architectureSchema.safeParse(loadFixture("zero-nodes.json"));
    expect(result.success).toBe(true);
  });
});

describe("architectureSchema — rejects invalid shapes", () => {
  test("rejects missing version field", () => {
    const result = architectureSchema.safeParse({
      nodes: [{ id: "a", label: "A", kind: "component" }],
      edges: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects version other than '1'", () => {
    const result = architectureSchema.safeParse({
      version: "2",
      nodes: [],
      edges: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown node kind", () => {
    const result = architectureSchema.safeParse({
      version: "1",
      nodes: [{ id: "a", label: "A", kind: "service" }],
      edges: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown edge kind", () => {
    const result = architectureSchema.safeParse({
      version: "1",
      nodes: [
        { id: "a", label: "A", kind: "component" },
        { id: "b", label: "B", kind: "component" },
      ],
      edges: [{ from: "a", to: "b", kind: "chirp" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects duplicate node ids", () => {
    const result = architectureSchema.safeParse({
      version: "1",
      nodes: [
        { id: "a", label: "A1", kind: "component" },
        { id: "a", label: "A2", kind: "component" },
      ],
      edges: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects unresolved edge.from", () => {
    const result = architectureSchema.safeParse({
      version: "1",
      nodes: [{ id: "a", label: "A", kind: "component" }],
      edges: [{ from: "ghost", to: "a", kind: "call" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects unresolved edge.to", () => {
    const result = architectureSchema.safeParse({
      version: "1",
      nodes: [{ id: "a", label: "A", kind: "component" }],
      edges: [{ from: "a", to: "ghost", kind: "call" }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects group member that is not a node", () => {
    const result = architectureSchema.safeParse({
      version: "1",
      nodes: [{ id: "a", label: "A", kind: "component" }],
      edges: [],
      groups: [{ id: "g", label: "g", members: ["a", "phantom"] }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects group id that clashes with a node id", () => {
    const result = architectureSchema.safeParse({
      version: "1",
      nodes: [{ id: "dup", label: "Dup", kind: "component" }],
      edges: [],
      groups: [{ id: "dup", label: "group", members: ["dup"] }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects invalid id grammar", () => {
    const result = architectureSchema.safeParse({
      version: "1",
      nodes: [{ id: "Has Space", label: "x", kind: "component" }],
      edges: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects unknown top-level keys (strict mode)", () => {
    const result = architectureSchema.safeParse({
      version: "1",
      nodes: [],
      edges: [],
      extra: "ignored",
    });
    expect(result.success).toBe(false);
  });
});

describe("architectureSchema — edges pointing at groups resolve", () => {
  test("edge targeting a group id is accepted", () => {
    const result = architectureSchema.safeParse({
      version: "1",
      nodes: [
        { id: "lead", label: "lead", kind: "component" },
        { id: "r1", label: "r1", kind: "component" },
        { id: "r2", label: "r2", kind: "component" },
      ],
      edges: [{ from: "lead", to: "reviewers", kind: "call" }],
      groups: [{ id: "reviewers", label: "reviewers", members: ["r1", "r2"] }],
    });
    expect(result.success).toBe(true);
  });
});

describe("parseArchitecture + emptyArchitecture", () => {
  test("parseArchitecture returns the parsed doc on valid input", () => {
    const doc = parseArchitecture(loadFixture("trivial.json"));
    expect(doc.version).toBe("1");
    expect(doc.nodes.length).toBe(2);
  });

  test("parseArchitecture throws on invalid input", () => {
    expect(() =>
      parseArchitecture({ version: "1", nodes: "oops", edges: [] }),
    ).toThrow(/schema/);
  });

  test("emptyArchitecture is version-1 with no nodes or edges", () => {
    const doc = emptyArchitecture();
    expect(doc.version).toBe("1");
    expect(doc.nodes).toEqual([]);
    expect(doc.edges).toEqual([]);
    const result = architectureSchema.safeParse(doc);
    expect(result.success).toBe(true);
  });
});
