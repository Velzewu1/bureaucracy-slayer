import {
  UserStateSchema,
  type ActionEvaluation,
  type JsonScalar,
  type PolicyCondition,
  type PolicyRule,
  type SafeActionPlan,
  type UserState,
} from "../contracts/index.js";
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

function evidenceStatus(
  rule: PolicyRule,
  analysis: DemoAnalysis,
): "verified" | "rejected" | "review_required" {
  if (rule.needsReview) return "review_required";
  if (analysis.evidence.rejectedRuleIds.includes(rule.id)) return "rejected";
  if (analysis.evidence.validRuleIds.includes(rule.id)) return "verified";
  return "review_required";
}

export function evidenceCards(analysis: DemoAnalysis) {
  return analysis.model.rules.flatMap((rule) =>
    rule.citations.map((citation) => ({
      id: `${rule.id}:${citation.blockId}`,
      ruleId: rule.id,
      effect: rule.effect,
      status: evidenceStatus(rule, analysis),
      condition: describeCondition(rule.appliesWhen),
      excerpt: citation.excerpt,
      pageUrl: citation.pageUrl,
      pageId: citation.pageId,
      blockId: citation.blockId,
      issueCodes: analysis.evidence.issues
        .filter((issue) => issue.ruleId === rule.id)
        .map((issue) => issue.code),
    })),
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
  return {
    changed:
      original.plan.id !== current.plan.id ||
      original.plan.status !== current.plan.status ||
      originalActionIds.join("|") !== currentActionIds.join("|"),
    originalStatus: planStatusPresentation(original.plan).label,
    currentStatus: planStatusPresentation(current.plan).label,
    removedActions: originalActionIds
      .filter((id) => !currentActionIds.includes(id))
      .map((id) => actionLabel(original, id)),
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
