// Copyright 2026 Nikolay Samokhvalov.

export type CiState = "missing" | "pending" | "failure" | "success";

export interface GithubCiStatus {
  readonly state: CiState;
  readonly source: "github";
  readonly detailsUrl?: string;
}

export type RevFindingSeverity =
  | "blocking"
  | "non-blocking"
  | "potential"
  | "info";

export interface RevFinding {
  readonly id: string;
  readonly severity: RevFindingSeverity;
  readonly category: string;
  readonly message: string;
}

export type RevGate =
  | {
      readonly state: "missing";
    }
  | {
      readonly state: "recorded";
      readonly commentPosted: boolean;
      readonly findings: readonly RevFinding[];
      readonly reportUrl?: string;
    };

export type ManualTestingGate =
  | {
      readonly state: "missing";
    }
  | {
      readonly state: "not-meaningful";
      readonly rationale: string;
    }
  | {
      readonly state: "present";
      readonly evidence: string;
    };

export interface LifecyclePolicy {
  readonly mergeAllowed: boolean;
  readonly releaseAllowed: boolean;
  readonly reason?: string;
}

export interface PrLifecycleInput {
  readonly prNumber: number;
  readonly authorLogin: string;
  readonly ci: GithubCiStatus;
  readonly rev: RevGate;
  readonly manualTesting: ManualTestingGate;
  readonly policy: LifecyclePolicy;
}

export type LifecycleState = "blocked" | "needs-author-action" | "merge-ready";

export interface LifecycleBlocker {
  readonly code:
    | "ci-not-green"
    | "rev-missing"
    | "rev-comment-missing"
    | "rev-blocking-findings"
    | "testing-evidence-missing"
    | "merge-policy-blocked"
    | "release-policy-blocked";
  readonly message: string;
  readonly action: string;
}

export interface LifecycleActions {
  readonly assignTo?: string;
  readonly postRevComment?: boolean;
}

export interface PrLifecycleResult {
  readonly prNumber: number;
  readonly lifecycleState: LifecycleState;
  readonly canMerge: boolean;
  readonly canRelease: boolean;
  readonly blockers: readonly LifecycleBlocker[];
  readonly actions: LifecycleActions;
}

export function evaluatePrLifecycle(
  input: PrLifecycleInput,
): PrLifecycleResult {
  const blockers: LifecycleBlocker[] = [];
  const actions: MutableLifecycleActions = {};

  addCiBlockers(input.ci, blockers);
  addRevBlockers(input, blockers, actions);
  addManualTestingBlockers(input.manualTesting, blockers);
  addPolicyBlockers(input.policy, blockers);

  const hasAuthorAction = actions.assignTo !== undefined;
  const lifecycleState =
    blockers.length === 0
      ? "merge-ready"
      : hasAuthorAction
        ? "needs-author-action"
        : "blocked";

  return {
    prNumber: input.prNumber,
    lifecycleState,
    canMerge:
      blockers.length === 0 &&
      input.policy.mergeAllowed &&
      input.ci.state === "success",
    canRelease: blockers.length === 0 && input.policy.releaseAllowed,
    blockers,
    actions,
  };
}

interface MutableLifecycleActions {
  assignTo?: string;
  postRevComment?: boolean;
}

function addCiBlockers(ci: GithubCiStatus, blockers: LifecycleBlocker[]): void {
  if (ci.state === "success") return;

  blockers.push({
    code: "ci-not-green",
    message: `GitHub CI must be green before merge. Current CI state: ${ci.state}.`,
    action: "Wait for CI to pass or fix the failing checks.",
  });
}

function addRevBlockers(
  input: PrLifecycleInput,
  blockers: LifecycleBlocker[],
  actions: MutableLifecycleActions,
): void {
  if (input.rev.state === "missing") {
    actions.postRevComment = true;
    blockers.push({
      code: "rev-missing",
      message: "REV must run against the PR diff before merge.",
      action:
        "Run REV, ignore SOC2-only findings, and post the report as a PR comment.",
    });
    return;
  }

  if (!input.rev.commentPosted) {
    actions.postRevComment = true;
    blockers.push({
      code: "rev-comment-missing",
      message: "The REV report must be posted to the PR before merge.",
      action: "Post the recorded REV report as a PR comment.",
    });
  }

  const blockingFindings = input.rev.findings.filter(
    (finding) => finding.severity === "blocking" && !isSoc2Finding(finding),
  );
  if (blockingFindings.length === 0) return;

  actions.assignTo = input.authorLogin;
  const noun = blockingFindings.length === 1 ? "finding" : "findings";
  blockers.push({
    code: "rev-blocking-findings",
    message:
      `REV has ${blockingFindings.length} blocking ${noun} ` +
      `that must be fixed.`,
    action: `Assign ${input.authorLogin} and rerun REV after fixes land.`,
  });
}

function addManualTestingBlockers(
  manualTesting: ManualTestingGate,
  blockers: LifecycleBlocker[],
): void {
  if (manualTesting.state !== "missing") return;

  blockers.push({
    code: "testing-evidence-missing",
    message: "Manual testing evidence must be posted before merge.",
    action:
      "Add a PR comment or PR body section with the focused manual testing evidence.",
  });
}

function addPolicyBlockers(
  policy: LifecyclePolicy,
  blockers: LifecycleBlocker[],
): void {
  const reason = policy.reason ?? "policy does not allow it";

  if (!policy.mergeAllowed) {
    blockers.push({
      code: "merge-policy-blocked",
      message: `Merge is blocked because ${reason}.`,
      action: "Wait for owner approval or update the merge policy decision.",
    });
  }

  if (!policy.releaseAllowed) {
    blockers.push({
      code: "release-policy-blocked",
      message: `Release is blocked because ${reason}.`,
      action: "Wait for owner approval or update the release policy decision.",
    });
  }
}

function isSoc2Finding(finding: RevFinding): boolean {
  return finding.category.trim().toLowerCase().startsWith("soc2");
}
