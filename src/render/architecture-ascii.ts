// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §3 + Issue #107 — deterministic ASCII renderer for an
 * architecture schema. Pure function of the input; no clocks, no
 * randomness.
 *
 * Contract (locked in the #107 scope comment):
 *   - Hard cap: every line <= 80 columns.
 *   - Soft cap: ~40 lines. When exceeded, sibling groups collapse
 *     to a single `[N <label>]` pill so the diagram still fits one
 *     terminal screen.
 *   - Labels exceeding the visible-label budget are truncated with
 *     `…`; the full label stays in architecture.json.
 *   - Zero-node schemas render as the literal placeholder
 *     `(architecture not yet specified)` (single line).
 *
 * Layout (v0.1): top-down by schema order, one box per node, arrows
 * listed in an Edges section below. Intentionally NOT a general graph
 * layout — see non-goals in #107.
 */

import type { Architecture, ArchitectureNode } from "../state/architecture.ts";

// ---------- constants ----------

/** Hard column cap per SPEC.md terminal-viewer guidance. */
const MAX_COLS = 80;
/** Soft line cap before group-collapse kicks in. */
const SOFT_LINES = 40;
/** Leading indent for inter-node connector rows. */
const CONNECTOR_INDENT = "  ";
/** Inner-box horizontal padding (one column each side). */
const BOX_PAD = 2;
/** The ellipsis character used for label truncation. */
const ELLIPSIS = "…";

// ---------- public API ----------

export function renderArchitectureAscii(doc: Architecture): string {
  if (doc.nodes.length === 0) {
    return "(architecture not yet specified)";
  }

  // First attempt: full render with group members expanded inline.
  const full = renderBody(doc, { collapseGroups: false });
  if (countLines(full) <= SOFT_LINES) {
    return full;
  }
  // Soft cap exceeded — collapse groups to counts.
  return renderBody(doc, { collapseGroups: true });
}

// ---------- internal render ----------

interface RenderOpts {
  readonly collapseGroups: boolean;
}

/**
 * Assemble the full diagram body as a newline-joined string. Both the
 * uncollapsed and collapsed passes share this so behavior stays
 * symmetric except for how group members are expanded.
 */
function renderBody(doc: Architecture, opts: RenderOpts): string {
  const lines: string[] = [];
  const groupIds = new Set((doc.groups ?? []).map((g) => g.id));
  const nodesById = new Map<string, ArchitectureNode>(
    doc.nodes.map((n) => [n.id, n]),
  );

  // Which node ids belong to a collapsed group? Those nodes are
  // rendered once via the group pill, never as a standalone box.
  const collapsedMemberIds = new Set<string>();
  if (opts.collapseGroups && doc.groups !== undefined) {
    for (const g of doc.groups) {
      for (const m of g.members) collapsedMemberIds.add(m);
    }
  }

  // --- nodes section ---
  const renderedPills = new Set<string>();

  for (const node of doc.nodes) {
    if (collapsedMemberIds.has(node.id)) {
      // Render the owning group's pill on first encounter; skip on
      // subsequent member iterations so members collapse into a single
      // pill in their original schema position.
      if (opts.collapseGroups && doc.groups !== undefined) {
        const owner = doc.groups.find((g) => g.members.includes(node.id));
        if (owner !== undefined && !renderedPills.has(owner.id)) {
          renderedPills.add(owner.id);
          const pill = `[${owner.members.length.toString()} ${owner.label}]`;
          lines.push(...renderBox(pill, "group"));
        }
      }
      continue;
    }
    lines.push(...renderBox(formatNodeLabel(node), node.kind));
  }

  // --- expanded groups section (only when groups aren't collapsed) ---
  if (
    !opts.collapseGroups &&
    doc.groups !== undefined &&
    doc.groups.length > 0
  ) {
    lines.push("");
    lines.push("groups:");
    for (const g of doc.groups) {
      lines.push(truncateLine(`- ${g.id} (${g.label}): ${g.members.join(", ")}`));
    }
  }

  // --- edges section ---
  if (doc.edges.length > 0) {
    lines.push("");
    lines.push("edges:");
    for (const e of doc.edges) {
      const kindMark = e.kind === "call" ? "→" : e.kind === "data" ? "⇢" : "⇒";
      // Sanity: if either endpoint's node is collapsed, show the owning
      // group id instead. This keeps the collapsed diagram consistent.
      const from = remapCollapsed(e.from, doc, opts, groupIds, nodesById);
      const to = remapCollapsed(e.to, doc, opts, groupIds, nodesById);
      const label = e.label === undefined ? "" : ` [${e.label}]`;
      lines.push(truncateLine(`- ${from} ${kindMark} ${to}${label}`));
    }
  }

  // --- notes section ---
  if (doc.notes !== undefined && doc.notes.length > 0) {
    lines.push("");
    lines.push("notes:");
    for (const n of doc.notes) {
      lines.push(truncateLine(`- ${n}`));
    }
  }

  return lines.join("\n");
}

// ---------- box rendering ----------

/**
 * Render a 3-line box for a node label + its kind, e.g.:
 *
 *   ┌──────────────────┐
 *   │ User (external)  │
 *   └──────────────────┘
 *
 * The label is pre-truncated if it would make the box exceed 80 cols.
 */
function renderBox(innerLabel: string, kind: string): string[] {
  const label = `${innerLabel}${kind === "group" ? "" : ` (${kind})`}`;
  // Budget: MAX_COLS − indent − 2 box bars − BOX_PAD padding columns.
  const maxInner = MAX_COLS - CONNECTOR_INDENT.length - 2 - BOX_PAD;
  const shown = truncate(label, maxInner);
  const width = shown.length + BOX_PAD;
  const top = `${CONNECTOR_INDENT}┌${"─".repeat(width)}┐`;
  const mid = `${CONNECTOR_INDENT}│ ${shown}${" ".repeat(width - shown.length - 1)}│`;
  const bot = `${CONNECTOR_INDENT}└${"─".repeat(width)}┘`;
  return [top, mid, bot];
}

function formatNodeLabel(n: ArchitectureNode): string {
  return n.label;
}

// ---------- label / line truncation ----------

/**
 * Cap `s` at `max` visual columns. When the raw string is already
 * within the limit, return as-is; otherwise reserve one column for `…`.
 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return ELLIPSIS;
  return `${s.slice(0, max - 1)}${ELLIPSIS}`;
}

/**
 * Per-line guard used for edge / group / note lines. Keeps the hard
 * 80-col invariant without tying width to any particular box-drawing
 * shape.
 */
function truncateLine(s: string): string {
  return truncate(s, MAX_COLS);
}

function countLines(s: string): number {
  // `split("\n")` always yields >= 1 element for a non-empty string.
  return s.split("\n").length;
}

// ---------- edge endpoint remapping ----------

function remapCollapsed(
  id: string,
  doc: Architecture,
  opts: RenderOpts,
  groupIds: Set<string>,
  nodesById: Map<string, ArchitectureNode>,
): string {
  // Group ids always render as-is.
  if (groupIds.has(id)) return id;
  // Node ids stay as-is unless the group-collapse pass has folded them
  // into a group pill — in which case we replace with the owning group's
  // id so the edge terminates at the right visible element.
  if (!opts.collapseGroups || doc.groups === undefined) return id;
  if (!nodesById.has(id)) return id;
  for (const g of doc.groups) {
    if (g.members.includes(id)) return g.id;
  }
  return id;
}
