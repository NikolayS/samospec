// Copyright 2026 Nikolay Samokhvalov.

// Shared schema barrel (SPEC §7 review taxonomy + §7 lead-ready
// protocol). Re-exports the review-taxonomy and revise response
// schemas so future callers can import from a single stable location
// without pulling the full adapter type surface.
//
// Authoritative definitions live in ./types.ts. This file exists so
// downstream modules (loop, reviewer, render) can depend on the
// schemas directly without re-exporting adapter internals.

export {
  FindingCategorySchema,
  FindingSeveritySchema,
  FindingSchema,
  CritiqueInputSchema,
  CritiqueOutputSchema,
  DecisionSchema,
  ReviseInputSchema,
  ReviseOutputSchema,
  type FindingCategory,
  type Finding,
  type CritiqueInput,
  type CritiqueOutput,
  type ReviseInput,
  type ReviseOutput,
} from "./types.ts";
