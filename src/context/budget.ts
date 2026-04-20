// Copyright 2026 Nikolay Samokhvalov.

/**
 * SPEC §7 — per-phase token budgets.
 *
 * Budgets are consumed in rank order (readme → manifest → arch-docs →
 * user-source → other). Files that would push us past the budget are
 * excluded; the downstream gist subsystem turns them into deterministic
 * gists (path + size + imports/exports) before envelope wrapping.
 *
 * Token estimation is deliberately coarse. We use a 4-chars-per-token
 * heuristic — adequate for budget guardrails before the real-usage
 * read back from the adapter. Once an adapter returns `usage.tokens`
 * we'll prefer those counts; the heuristic is only used for the
 * pre-call fit check.
 */

export interface ContextBudgets {
  readonly interview: number;
  readonly draft: number;
  readonly revision: number;
}

/** SPEC §7: interview 5K / draft 30K / revision 20K (+ current spec). */
export const DEFAULT_CONTEXT_BUDGETS: ContextBudgets = {
  interview: 5_000,
  draft: 30_000,
  revision: 20_000,
};

/**
 * Approximate token count from UTF-16 char count via the 4-char
 * heuristic. The smallest non-empty string counts as 1 token so zero
 * never hides a truly-present file.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface BudgetFile {
  readonly path: string;
  readonly content: string;
}

export interface BudgetPlan {
  readonly included: readonly BudgetFile[];
  readonly excluded: readonly BudgetFile[];
  readonly tokensUsed: number;
  readonly tokensBudget: number;
}

export interface FitFilesToBudgetArgs {
  readonly files: readonly BudgetFile[];
  readonly budgetTokens: number;
}

/**
 * Walk `files` in order, admitting each as long as its token estimate
 * fits the remaining budget. Oversized files that would overshoot are
 * excluded (not split). Zero budget ⇒ everything excluded.
 */
export function fitFilesToBudget(args: FitFilesToBudgetArgs): BudgetPlan {
  const included: BudgetFile[] = [];
  const excluded: BudgetFile[] = [];
  let used = 0;
  for (const f of args.files) {
    const t = estimateTokens(f.content);
    if (used + t <= args.budgetTokens) {
      included.push(f);
      used += t;
    } else {
      excluded.push(f);
    }
  }
  return {
    included,
    excluded,
    tokensUsed: used,
    tokensBudget: args.budgetTokens,
  };
}
