// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §3 + Issue #107 — structured architecture schema.
 *
 * Canonical machine-readable representation of a spec's architecture:
 * a small graph of nodes + edges, with optional groups for sibling
 * collapse in the ASCII renderer and free-form notes.
 *
 * This module only validates + parses. The ASCII renderer lives in
 * `src/render/architecture-ascii.ts`; the SPEC.md injection helpers
 * live in `src/render/architecture-spec.ts`. Keeping those concerns
 * separate so the schema is the sole source of truth — renderers are
 * pure functions of the schema.
 *
 * Scope decisions (locked in issue #107 scope comment):
 *   - `version: "1"` only. No migration path yet.
 *   - Node kinds: external | component | datastore | boundary.
 *   - Edge kinds: call | data | control.
 *   - IDs must be unique across nodes + groups.
 *   - Every edge endpoint must resolve to a node id OR a group id.
 *   - Every group member must resolve to a node id.
 *   - Zero-node schemas are valid (rendered as a placeholder).
 */

import { z } from "zod";

export const ARCHITECTURE_NODE_KINDS = [
  "external",
  "component",
  "datastore",
  "boundary",
] as const;
export type ArchitectureNodeKind = (typeof ARCHITECTURE_NODE_KINDS)[number];

export const ARCHITECTURE_EDGE_KINDS = ["call", "data", "control"] as const;
export type ArchitectureEdgeKind = (typeof ARCHITECTURE_EDGE_KINDS)[number];

/** ID grammar: lowercase letters, digits, hyphen/underscore. 1..64 chars. */
const idSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,63}$/,
    "id must be lowercase alphanumeric with '-' or '_' (1-64 chars)",
  );

/** Labels are free-form user prose but must be single-line + bounded. */
const labelSchema = z
  .string()
  .min(1, "label must be non-empty")
  .max(256, "label must be <= 256 chars")
  .refine((s) => !/[\r\n]/.test(s), "label must be single-line");

export const architectureNodeSchema = z
  .object({
    id: idSchema,
    label: labelSchema,
    kind: z.enum(ARCHITECTURE_NODE_KINDS),
  })
  .strict();
export type ArchitectureNode = z.infer<typeof architectureNodeSchema>;

export const architectureEdgeSchema = z
  .object({
    from: idSchema,
    to: idSchema,
    label: labelSchema.optional(),
    kind: z.enum(ARCHITECTURE_EDGE_KINDS),
  })
  .strict();
export type ArchitectureEdge = z.infer<typeof architectureEdgeSchema>;

export const architectureGroupSchema = z
  .object({
    id: idSchema,
    label: labelSchema,
    members: z.array(idSchema).min(1, "group must have >= 1 member"),
  })
  .strict();
export type ArchitectureGroup = z.infer<typeof architectureGroupSchema>;

/**
 * Core architecture document. The `superRefine` pass enforces cross-
 * field invariants that plain Zod shape can't (unique ids, edge
 * endpoint resolution, group membership resolution).
 */
export const architectureSchema = z
  .object({
    version: z.literal("1"),
    nodes: z.array(architectureNodeSchema),
    edges: z.array(architectureEdgeSchema),
    groups: z.array(architectureGroupSchema).optional(),
    notes: z.array(z.string().min(1).max(512)).optional(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const nodeIds = new Set<string>();
    for (const [i, n] of doc.nodes.entries()) {
      if (nodeIds.has(n.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["nodes", i, "id"],
          message: `duplicate node id '${n.id}'`,
        });
      }
      nodeIds.add(n.id);
    }
    const groupIds = new Set<string>();
    const groupMemberIds = new Set<string>();
    if (doc.groups !== undefined) {
      for (const [i, g] of doc.groups.entries()) {
        if (groupIds.has(g.id) || nodeIds.has(g.id)) {
          ctx.addIssue({
            code: "custom",
            path: ["groups", i, "id"],
            message: `duplicate id '${g.id}' (clashes with a node or group)`,
          });
        }
        groupIds.add(g.id);
        for (const [j, m] of g.members.entries()) {
          if (!nodeIds.has(m)) {
            ctx.addIssue({
              code: "custom",
              path: ["groups", i, "members", j],
              message: `group '${g.id}' member '${m}' does not resolve to a node`,
            });
          }
          groupMemberIds.add(m);
        }
      }
    }
    const resolvable = new Set<string>([...nodeIds, ...groupIds]);
    for (const [i, e] of doc.edges.entries()) {
      if (!resolvable.has(e.from)) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", i, "from"],
          message: `edge.from '${e.from}' does not resolve to a node or group`,
        });
      }
      if (!resolvable.has(e.to)) {
        ctx.addIssue({
          code: "custom",
          path: ["edges", i, "to"],
          message: `edge.to '${e.to}' does not resolve to a node or group`,
        });
      }
    }
  });

export type Architecture = z.infer<typeof architectureSchema>;

/**
 * Parse-or-throw: used by callers that have already confirmed the
 * caller is in an error-path (CLI fails hard on a malformed JSON).
 */
export function parseArchitecture(raw: unknown): Architecture {
  const result = architectureSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `architecture.json failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Empty placeholder document: version-1, no nodes. Produced by `new`
 * when the lead adapter didn't emit an architecture (the ASCII
 * renderer substitutes a `(architecture not yet specified)` block).
 */
export function emptyArchitecture(): Architecture {
  return { version: "1", nodes: [], edges: [] };
}
