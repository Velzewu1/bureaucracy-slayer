import {
  UserStateSchema,
  type ActionEvaluation,
  type JsonScalar,
  type PolicyCondition,
  type PolicyRule,
  type SafeActionPlan,
  type UserState,
} from "../contracts/index.js";
import {
  buildDecisionTrace,
  type RuleDecisionTrace,
} from "../decision/index.js";
import type { DemoAnalysis } from "./types.js";

export type Tone = "positive" | "warning" | "danger" | "neutral" | "info";

export type StatusPresentation = Readonly<{
  label: string;
  tone: Tone;
  summary: string;
}>;

const reasonLabels: Readonly<Record<string, string>> = {
  ACTION_UNVERIFIED: "The website action is unavailable or was not verified.",
  ARTIFACT_MISMATCH: "The plan is bound to different source artifacts.",
  DEPENDENCY_CYCLE: "The action route contains a dependency cycle.",
  EVIDENCE_INVALID: "Required policy evidence is invalid.",
  EVIDENCE_REJECTED: "At least one policy rule has rejected evidence.",
  FACT_TYPE_MISMATCH: "A supplied fact has the wrong type.",
  MISSING_FACTS: "More user information is required.",
  MISSING_PREREQUISITE: "A required prior action is missing.",
  MISSING_STEP_PROVENANCE: "A route step lacks required policy provenance.",
  NOT_PERMITTED: "No active verified rule permits this action.",
  NO_ROUTE: "No supported route is available.",
  PERMITTED: "A verified active rule permits this action.",
  POLICY_CONFLICT: "Verified policy rules simultaneously permit and prohibit this action.",
  PROHIBITED: "An active verified rule prohibits this action.",
  REQUIREMENT_FAILED: "A mandatory condition is not satisfied.",
  ROUTE_READY: "Every action in this route passed deterministic checks.",
  USER_STATE_HASH_MISMATCH: "The plan does not match the current user facts.",
};

export function readableReason(code: string): string {
  return reasonLabels[code] ?? code.replaceAll("_", " ").toLocaleLowerCase();
}

export type RuleConditionState = "matched" | "not_matched" | "unresolved";
export type RuleEvidenceState = "verified" | "rejected" | "unknown";

const conditionLabels: Readonly<Record<RuleConditionState, string>> = {
  matched: "Condition matched",
  not_matched: "Condition not matched",
  unresolved: "Condition unresolved",
};

const evidenceStateLabels: Readonly<Record<RuleEvidenceState, string>> = {
  verified: "Evidence verified",
  rejected: "Evidence rejected",
  unknown: "Evidence status unknown",
};

function conditionState(
  applicabilityState: RuleDecisionTrace["applicabilityState"],
): RuleConditionState {
  switch (applicabilityState) {
    case "active":
      return "matched";
    case "inactive":
      return "not_matched";
    case "potential":
      return "unresolved";
  }
}

function ruleEvidenceState(
  ruleId: string,
  analysis: DemoAnalysis,
): RuleEvidenceState {
  if (analysis.evidence.rejectedRuleIds.includes(ruleId)) return "rejected";
  if (analysis.evidence.validRuleIds.includes(ruleId)) return "verified";
  return "unknown";
}

function uniqueMessages(messages: readonly (string | undefined)[]): string[] {
  return [
    ...new Set(
      messages.filter((message): message is string => message !== undefined),
    ),
  ];
}

export function actionReadinessPresentation(
  status: ActionEvaluation["status"],
): StatusPresentation {
  switch (status) {
    case "allowed":
      return {
        label: "Action ready",
        tone: "positive",
        summary: "The current action passed the authoritative deterministic decision.",
      };
    case "forbidden":
      return {
        label: "Action prohibited",
        tone: "danger",
        summary: "The current action is prohibited by the authoritative decision.",
      };
    case "review":
      return {
        label: "Human review required",
        tone: "warning",
        summary: "The current action cannot proceed until the review gate is resolved.",
      };
    case "indeterminate":
      return {
        label: "More information required",
        tone: "warning",
        summary: "The current action remains unresolved because required facts are unknown.",
      };
  }
}

export function policyRulePresentations(analysis: DemoAnalysis) {
  const tracesByRuleId = new Map(
    [...new Set(analysis.model.rules.map((rule) => rule.actionId))]
      .flatMap((actionId) =>
        buildDecisionTrace(
          {
            model: analysis.model,
            evidence: analysis.evidence,
            evaluation: analysis.evaluation,
            plan: analysis.plan,
            userState: analysis.userState,
          },
          actionId,
        ).rules,
      )
      .map((trace) => [trace.ruleId, trace] as const),
  );

  return analysis.model.rules.map((rule) => {
    const trace = tracesByRuleId.get(rule.id);
    if (trace === undefined) {
      throw new Error(`No decision trace exists for policy rule ${rule.id}`);
    }
    const evidenceIssues = analysis.evidence.issues.filter(
      (issue) => issue.ruleId === rule.id,
    );
    const auditFindings = analysis.semanticAuditFindings.filter(
      (finding) => finding.ruleId === rule.id,
    );
    const evidenceState = ruleEvidenceState(rule.id, analysis);
    const applicability = conditionState(trace.applicabilityState);
    const semanticReviewRequired =
      rule.needsReview ||
      evidenceIssues.some((issue) => issue.code === "SEMANTIC_REVIEW_REQUIRED") ||
      auditFindings.length > 0;

    return {
      ruleId: rule.id,
      actionId: rule.actionId,
      effect: rule.effect,
      applicability,
      conditionLabel: conditionLabels[applicability],
      evidenceState,
      evidenceLabel: evidenceStateLabels[evidenceState],
      semanticReviewRequired,
      rejectionReasons: uniqueMessages([
        ...(rule.needsReview ? [rule.reviewReason] : []),
        ...evidenceIssues.map((issue) => issue.message),
        ...auditFindings.map((finding) => finding.message),
      ]),
      issueCodes: [
        ...new Set([
          ...evidenceIssues.map((issue) => issue.code),
          ...auditFindings.map((finding) => finding.code),
        ]),
      ],
      trace,
    };
  });
}

export function planStatusPresentation(plan: SafeActionPlan): StatusPresentation {
  switch (plan.status) {
    case "ready":
      return {
        label: "Safe route found",
        tone: "positive",
        summary: "Every displayed step is supported by verified policy evidence.",
      };
    case "needs_information":
      return {
        label: "More information needed",
        tone: "warning",
        summary: "The planner stopped because a mandatory fact is unknown.",
      };
    case "blocked":
      return {
        label: "No permitted route",
        tone: "danger",
        summary: "The deterministic checks excluded all candidate routes.",
      };
    case "review_required":
      return {
        label: "Human review required",
        tone: "warning",
        summary: "Evidence or policy conflicts prevent a confident recommendation.",
      };
    case "stale":
      return {
        label: "Plan is stale",
        tone: "neutral",
        summary: "The source artifacts or user facts no longer match this plan.",
      };
  }
}

function formatScalar(value: JsonScalar): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

export function describeCondition(condition: PolicyCondition): string {
  switch (condition.kind) {
    case "always":
      return "Always applies";
    case "fact": {
      const value = Array.isArray(condition.value)
        ? condition.value.map(formatScalar).join(", ")
        : formatScalar(condition.value);
      return `${condition.fact} ${condition.op.replaceAll("_", " ")} ${value}`;
    }
    case "not":
      return `Not (${describeCondition(condition.condition)})`;
    case "all":
      return condition.conditions.map(describeCondition).join(" AND ");
    case "any":
      return condition.conditions.map(describeCondition).join(" OR ");
  }
}

export type EvidenceCardStatus =
  | "verified"
  | "citation_mismatch"
  | "invalid_binding"
  | "semantic_review"
  | "audit_review"
  | "valid_unusable";

const citationMismatchCodes = new Set(["EXCERPT_MISMATCH", "PAGE_MISSING", "BLOCK_MISSING"]);
const invalidBindingCodes = new Set([
  "ACTION_MISSING",
  "ACTION_UNAVAILABLE",
  "CROSS_ORIGIN_BLOCKED",
  "REFERENCE_INVALID",
  "DEPENDENCY_CYCLE",
  "SNAPSHOT_MISMATCH",
]);

function evidenceStatus(
  rule: PolicyRule,
  analysis: DemoAnalysis,
  issueCodes: readonly string[],
  hasAuditFinding: boolean,
): EvidenceCardStatus {
  if (issueCodes.some((code) => citationMismatchCodes.has(code))) return "citation_mismatch";
  if (issueCodes.some((code) => invalidBindingCodes.has(code))) return "invalid_binding";
  if (hasAuditFinding) return "audit_review";
  if (rule.needsReview || issueCodes.includes("SEMANTIC_REVIEW_REQUIRED")) {
    return "semantic_review";
  }
  if (analysis.evidence.rejectedRuleIds.includes(rule.id)) return "valid_unusable";
  if (analysis.evidence.validRuleIds.includes(rule.id)) return "verified";
  return "valid_unusable";
}

export function evidenceCards(analysis: DemoAnalysis) {
  const rulePresentations = new Map(
    policyRulePresentations(analysis).map((rule) => [rule.ruleId, rule] as const),
  );
  return analysis.model.rules.flatMap((rule) =>
    rule.citations.map((citation) => {
      const presentation = rulePresentations.get(rule.id);
      if (presentation === undefined) {
        throw new Error(`No UI presentation exists for policy rule ${rule.id}`);
      }
      const evidenceIssues = analysis.evidence.issues
        .filter((issue) => issue.ruleId === rule.id)
        .filter(
          (issue) =>
            !citationMismatchCodes.has(issue.code) || issue.message.includes(citation.blockId),
        );
      const auditFindings = analysis.semanticAuditFindings.filter(
        (finding) => finding.ruleId === rule.id,
      );
      const issueCodes = [...new Set(evidenceIssues.map((issue) => issue.code))];
      const status = evidenceStatus(rule, analysis, issueCodes, auditFindings.length > 0);
      const allIssues = [
        ...evidenceIssues.map((issue) => ({ code: issue.code, message: issue.message })),
        ...auditFindings.map((finding) => ({ code: finding.code, message: finding.message })),
      ];
      const displayedIssues = [
        ...new Map(allIssues.map((issue) => [issue.code, issue] as const)).values(),
      ];
      const whyUnsafe =
        status === "citation_mismatch"
          ? "The quoted text could not be matched exactly to the recorded source, so this rule is unusable."
          : status === "invalid_binding"
            ? "The rule does not have a valid source, action, or reference binding and cannot support a safe action."
            : status === "audit_review"
              ? "The citation matches, but the independent audit found policy scope that the structured permission may omit."
              : status === "semantic_review"
                ? "The citation matches, but the extracted interpretation remains uncertain and cannot authorize this action."
                : status === "valid_unusable"
                  ? "The citation may match, but this rejected rule remains unusable for planning."
                  : undefined;
      return {
        id: `${rule.id}:${citation.blockId}`,
        ruleId: rule.id,
        effect: rule.effect,
        status,
        conditionState: presentation.applicability,
        conditionLabel: presentation.conditionLabel,
        evidenceState: presentation.evidenceState,
        evidenceLabel: presentation.evidenceLabel,
        semanticReviewRequired: presentation.semanticReviewRequired,
        condition: describeCondition(rule.appliesWhen),
        excerpt: citation.excerpt,
        pageUrl: citation.pageUrl,
        pageId: citation.pageId,
        blockId: citation.blockId,
        issueCodes,
        issues: displayedIssues,
        additionalIssueCount: allIssues.length - displayedIssues.length,
        whyUnsafe,
      };
    }),
  );
}

function actionLabel(analysis: DemoAnalysis, actionId: string): string {
  return analysis.model.actions.find((action) => action.id === actionId)?.label ?? actionId;
}

export function excludedActions(analysis: DemoAnalysis) {
  return analysis.evaluation.decisions
    .filter((decision) => decision.status !== "allowed")
    .map((decision) => ({
      id: decision.actionId,
      label: actionLabel(analysis, decision.actionId),
      status: decision.status,
      reasons: decision.reasonCodes.map(readableReason),
      reasonCodes: decision.reasonCodes,
      missingFacts: decision.missingFacts,
      citationRuleIds: decision.citationRuleIds,
    }));
}

export function routeSteps(analysis: DemoAnalysis) {
  return analysis.plan.steps.map((step) => {
    const procedureAction = analysis.model.actions.find(
      (action) => action.id === step.procedureActionId,
    );
    const websiteAction = analysis.snapshot.pages
      .flatMap((page) => page.actions)
      .find((action) => action.id === step.websiteActionId);
    const citations = analysis.model.rules
      .filter((rule) => step.citationRuleIds.includes(rule.id))
      .flatMap((rule) =>
        rule.citations.map((citation) => ({
          ruleId: rule.id,
          excerpt: citation.excerpt,
          pageUrl: citation.pageUrl,
        })),
      );
    return {
      ...step,
      title: procedureAction?.label ?? step.procedureActionId,
      actionKind: procedureAction?.kind ?? "user_task",
      observedActionLabel: websiteAction?.label,
      observedActionKind: websiteAction?.kind,
      citations,
    };
  });
}

export function updateUserFact(
  userState: UserState,
  factKey: string,
  value: JsonScalar | undefined,
): UserState {
  const facts = { ...userState.facts };
  if (value === undefined) {
    delete facts[factKey];
  } else {
    facts[factKey] = value;
  }
  return UserStateSchema.parse({
    schemaVersion: 1,
    revision: userState.revision,
    facts,
  });
}

export function planDifference(original: DemoAnalysis, current: DemoAnalysis) {
  const originalActionIds = original.plan.steps.map((step) => step.procedureActionId);
  const currentActionIds = current.plan.steps.map((step) => step.procedureActionId);
  const factKeys = [
    ...new Set([
      ...Object.keys(original.userState.facts),
      ...Object.keys(current.userState.facts),
    ]),
  ].sort();
  const changedFacts = factKeys
    .filter((key) => original.userState.facts[key] !== current.userState.facts[key])
    .map((key) => ({
      key,
      label:
        current.model.factDefinitions.find((definition) => definition.key === key)?.label ??
        key,
      before: original.userState.facts[key],
      after: current.userState.facts[key],
    }));
  const removedActionDetails = originalActionIds
    .filter((id) => !currentActionIds.includes(id))
    .map((id) => {
      const decision = current.evaluation.decisions.find(
        (candidate) => candidate.actionId === id,
      );
      return {
        id,
        label: actionLabel(original, id),
        status: decision?.status,
        reasons: decision?.reasonCodes.map(readableReason) ?? [],
      };
    });
  return {
    changed:
      original.plan.id !== current.plan.id ||
      original.plan.status !== current.plan.status ||
      originalActionIds.join("|") !== currentActionIds.join("|"),
    originalStatus: planStatusPresentation(original.plan).label,
    currentStatus: planStatusPresentation(current.plan).label,
    removedActions: removedActionDetails.map((action) => action.label),
    removedActionDetails,
    addedActions: currentActionIds
      .filter((id) => !originalActionIds.includes(id))
      .map((id) => actionLabel(current, id)),
    changedFacts,
    decisionBefore: original.decisionIntelligence.trace.decision.status,
    decisionAfter: current.decisionIntelligence.trace.decision.status,
    snapshotUnchanged: original.snapshot.id === current.snapshot.id,
    evidenceUnchanged: original.evidence.id === current.evidence.id,
  };
}

export function decisionTone(status: ActionEvaluation["status"]): Tone {
  switch (status) {
    case "allowed":
      return "positive";
    case "forbidden":
      return "danger";
    case "indeterminate":
      return "warning";
    case "review":
      return "warning";
  }
}
