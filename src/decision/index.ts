import {
  UserStateSchema,
  hashCanonical,
  type ActionEvaluation,
  type ConditionEvaluation,
  type EvidenceCitation,
  type EvidenceResult,
  type EvaluationResult,
  type JsonScalar,
  type PolicyCondition,
  type PolicyRule,
  type ProcedureModel,
  type SafeActionPlan,
  type TruthValue,
  type UserState,
} from "../contracts/index.js";
import { evaluateCondition, evaluatePolicies, planActions } from "../engine/index.js";

const MAX_COUNTERFACTUAL_COMPUTATIONS = 12;
const MAX_QUESTION_COMPUTATIONS = 12;

export type FactInfluence = Readonly<{
  key: string;
  operator: Extract<PolicyCondition, { kind: "fact" }>["op"];
  expected: JsonScalar | readonly JsonScalar[];
  known: boolean;
  actual?: JsonScalar;
  truth: TruthValue;
}>;

export type RuleDecisionTrace = Readonly<{
  ruleId: string;
  effect: PolicyRule["effect"];
  applicability: ConditionEvaluation;
  applicabilityState: "active" | "potential" | "inactive";
  requirement?: ConditionEvaluation;
  facts: readonly FactInfluence[];
  citations: readonly EvidenceCitation[];
  evidenceStatus: "verified" | "rejected" | "review_required";
}>;

export type DecisionTrace = Readonly<{
  actionId: string;
  actionLabel: string;
  decision: ActionEvaluation;
  rules: readonly RuleDecisionTrace[];
  missingFacts: readonly string[];
  planStatus: SafeActionPlan["status"];
  planReasonCodes: readonly string[];
}>;

export type CounterfactualResult = Readonly<{
  factKey: string;
  factLabel: string;
  originalValue?: JsonScalar;
  hypotheticalValue: JsonScalar;
  hypotheticalRevision: number;
  decisionBefore: ActionEvaluation["status"];
  decisionAfter: ActionEvaluation["status"];
  planStatusBefore: SafeActionPlan["status"];
  planStatusAfter: SafeActionPlan["status"];
  routeBefore: readonly string[];
  routeAfter: readonly string[];
  unresolvedFacts: readonly string[];
  changed: boolean;
}>;

export type QuestionAlternative = Readonly<{
  value: JsonScalar;
  planStatus: SafeActionPlan["status"];
  actionDecision: ActionEvaluation["status"];
  routeActionIds: readonly string[];
  unresolvedFacts: readonly string[];
}>;

export type AdaptiveQuestion = Readonly<{
  factKey: string;
  label: string;
  alternatives: readonly QuestionAlternative[];
  distinctOutcomeCount: number;
  priorityScore: number;
  whyItMatters: string;
}>;

export type DecisionIntelligence = Readonly<{
  selectedActionId: string;
  trace: DecisionTrace;
  counterfactuals: readonly CounterfactualResult[];
  questions: readonly AdaptiveQuestion[];
  nextQuestion?: AdaptiveQuestion;
  computationCount: number;
}>;

export type DecisionInputs = Readonly<{
  model: ProcedureModel;
  evidence: EvidenceResult;
  evaluation: EvaluationResult;
  plan: SafeActionPlan;
  userState: UserState;
}>;

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function scalarKey(value: JsonScalar): string {
  return `${typeof value}:${String(value)}`;
}

function factAlternatives(
  definition: ProcedureModel["factDefinitions"][number],
): readonly JsonScalar[] {
  const values =
    definition.allowedValues ??
    (definition.type === "boolean" ? ([false, true] as const) : []);
  return [...new Map(values.map((value) => [scalarKey(value), value])).values()].sort((left, right) =>
    scalarKey(left).localeCompare(scalarKey(right)),
  );
}

function factsForCondition(
  condition: PolicyCondition,
  facts: Readonly<Record<string, JsonScalar>>,
): FactInfluence[] {
  switch (condition.kind) {
    case "always":
      return [];
    case "fact": {
      const result = evaluateCondition(condition, facts);
      const actual = facts[condition.fact];
      return [
        {
          key: condition.fact,
          operator: condition.op,
          expected: condition.value,
          known: actual !== undefined,
          ...(actual === undefined ? {} : { actual }),
          truth: result.value,
        },
      ];
    }
    case "not":
      return factsForCondition(condition.condition, facts);
    case "all":
    case "any":
      return condition.conditions.flatMap((child) => factsForCondition(child, facts));
  }
}

function evidenceStatus(
  rule: PolicyRule,
  evidence: EvidenceResult,
): RuleDecisionTrace["evidenceStatus"] {
  if (evidence.rejectedRuleIds.includes(rule.id)) return "rejected";
  if (rule.needsReview || !evidence.validRuleIds.includes(rule.id)) return "review_required";
  return "verified";
}

function traceRule(
  rule: PolicyRule,
  evidence: EvidenceResult,
  userState: UserState,
): RuleDecisionTrace {
  const applicability = evaluateCondition(rule.appliesWhen, userState.facts);
  const requirement =
    rule.effect === "require_condition" && applicability.value === "true"
      ? evaluateCondition(rule.requirement, userState.facts)
      : undefined;
  const conditions =
    rule.effect === "require_condition"
      ? [rule.appliesWhen, rule.requirement]
      : [rule.appliesWhen];
  return {
    ruleId: rule.id,
    effect: rule.effect,
    applicability,
    applicabilityState:
      applicability.value === "true"
        ? "active"
        : applicability.value === "unknown"
          ? "potential"
          : "inactive",
    ...(requirement === undefined ? {} : { requirement }),
    facts: conditions.flatMap((condition) => factsForCondition(condition, userState.facts)),
    citations: rule.citations,
    evidenceStatus: evidenceStatus(rule, evidence),
  };
}

function decisionById(evaluation: EvaluationResult, actionId: string): ActionEvaluation {
  const decision = evaluation.decisions.find((candidate) => candidate.actionId === actionId);
  if (decision === undefined) throw new Error(`No evaluator decision exists for action ${actionId}`);
  return decision;
}

function routeSize(
  model: ProcedureModel,
  evaluation: EvaluationResult,
  actionId: string,
  seen: ReadonlySet<string> = new Set(),
): number {
  if (seen.has(actionId)) return Number.MAX_SAFE_INTEGER;
  const action = model.actions.find((candidate) => candidate.id === actionId);
  const decision = evaluation.decisions.find((candidate) => candidate.actionId === actionId);
  if (action === undefined || decision === undefined) return Number.MAX_SAFE_INTEGER;
  const nextSeen = new Set(seen);
  nextSeen.add(actionId);
  const dependencies = uniqueSorted([
    ...action.prerequisiteActionIds,
    ...decision.requiredActionIds,
  ]);
  return 1 + dependencies.reduce(
    (total, dependencyId) => total + routeSize(model, evaluation, dependencyId, nextSeen),
    0,
  );
}

function statusMatchesPlan(
  decisionStatus: ActionEvaluation["status"],
  planStatus: SafeActionPlan["status"],
): boolean {
  if (planStatus === "needs_information") return decisionStatus === "indeterminate";
  if (planStatus === "review_required") return decisionStatus === "review";
  if (planStatus === "blocked") return decisionStatus === "forbidden";
  return false;
}

export function selectDecisionAction(inputs: DecisionInputs): string {
  const selectedStep = inputs.plan.steps.at(-1);
  if (selectedStep !== undefined) return selectedStep.procedureActionId;

  const candidates = inputs.model.goalActionIds
    .map((actionId) => ({
      actionId,
      action: inputs.model.actions.find((candidate) => candidate.id === actionId),
      decision: inputs.evaluation.decisions.find((candidate) => candidate.actionId === actionId),
    }))
    .filter(
      (candidate): candidate is {
        actionId: string;
        action: ProcedureModel["actions"][number];
        decision: ActionEvaluation;
      } => candidate.action !== undefined && candidate.decision !== undefined,
    )
    .filter((candidate) => statusMatchesPlan(candidate.decision.status, inputs.plan.status))
    .sort(
      (left, right) =>
        routeSize(inputs.model, inputs.evaluation, left.actionId) -
          routeSize(inputs.model, inputs.evaluation, right.actionId) ||
        Number(left.action.kind === "user_task") - Number(right.action.kind === "user_task") ||
        left.actionId.localeCompare(right.actionId),
    );
  const selected = candidates[0] ?? {
    actionId: [...inputs.model.goalActionIds].sort()[0],
  };
  if (selected.actionId === undefined) throw new Error("Procedure model has no goal action");
  return selected.actionId;
}

export function buildDecisionTrace(
  inputs: DecisionInputs,
  actionId = selectDecisionAction(inputs),
): DecisionTrace {
  const action = inputs.model.actions.find((candidate) => candidate.id === actionId);
  if (action === undefined) throw new Error(`Unknown procedure action ${actionId}`);
  const decision = decisionById(inputs.evaluation, actionId);
  return {
    actionId,
    actionLabel: action.label,
    decision,
    rules: inputs.model.rules
      .filter((rule) => rule.actionId === actionId)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((rule) => traceRule(rule, inputs.evidence, inputs.userState)),
    missingFacts: uniqueSorted(decision.missingFacts),
    planStatus: inputs.plan.status,
    planReasonCodes: inputs.plan.reasonCodes,
  };
}

function hypotheticalPlan(
  inputs: DecisionInputs,
  factKey: string,
  value: JsonScalar,
): Readonly<{
  userState: UserState;
  evaluation: EvaluationResult;
  plan: SafeActionPlan;
}> {
  const userState = UserStateSchema.parse({
    schemaVersion: 1,
    revision: inputs.userState.revision + 1,
    facts: { ...inputs.userState.facts, [factKey]: value },
  });
  const evaluation = evaluatePolicies(inputs.model, inputs.evidence, userState);
  const userStateHash = hashCanonical(userState);
  const plan = planActions(inputs.model, inputs.evidence, evaluation, userState, {
    planId: `plan_${hashCanonical({
      kind: "decision-counterfactual",
      procedureModelId: inputs.model.id,
      userState,
    }).slice(0, 20)}`,
    generatedAt: inputs.plan.generatedAt,
    userStateHash,
  });
  return { userState, evaluation, plan };
}

function sameRoute(left: SafeActionPlan, right: SafeActionPlan): boolean {
  return (
    left.status === right.status &&
    left.steps.map((step) => step.procedureActionId).join("|") ===
      right.steps.map((step) => step.procedureActionId).join("|")
  );
}

export function analyzeCounterfactuals(
  inputs: DecisionInputs,
  actionId = selectDecisionAction(inputs),
  limit = MAX_COUNTERFACTUAL_COMPUTATIONS,
): readonly CounterfactualResult[] {
  const originalDecision = decisionById(inputs.evaluation, actionId);
  let computationCount = 0;
  const results: CounterfactualResult[] = [];
  for (const definition of [...inputs.model.factDefinitions].sort((left, right) =>
    left.key.localeCompare(right.key),
  )) {
    const originalValue = inputs.userState.facts[definition.key];
    for (const alternative of factAlternatives(definition)) {
      if (originalValue === alternative) continue;
      if (computationCount >= limit) return results;
      computationCount += 1;
      const hypothetical = hypotheticalPlan(inputs, definition.key, alternative);
      const hypotheticalDecision = decisionById(hypothetical.evaluation, actionId);
      results.push({
        factKey: definition.key,
        factLabel: definition.label,
        ...(originalValue === undefined ? {} : { originalValue }),
        hypotheticalValue: alternative,
        hypotheticalRevision: hypothetical.userState.revision,
        decisionBefore: originalDecision.status,
        decisionAfter: hypotheticalDecision.status,
        planStatusBefore: inputs.plan.status,
        planStatusAfter: hypothetical.plan.status,
        routeBefore: inputs.plan.steps.map((step) => step.procedureActionId),
        routeAfter: hypothetical.plan.steps.map((step) => step.procedureActionId),
        unresolvedFacts: hypothetical.plan.missingFacts,
        changed:
          originalDecision.status !== hypotheticalDecision.status ||
          !sameRoute(inputs.plan, hypothetical.plan),
      });
    }
  }
  return results;
}

function outcomeKey(alternative: QuestionAlternative): string {
  return [
    alternative.planStatus,
    alternative.actionDecision,
    alternative.routeActionIds.join("|"),
    alternative.unresolvedFacts.join("|"),
  ].join(":");
}

export function rankAdaptiveQuestions(
  inputs: DecisionInputs,
  actionId = selectDecisionAction(inputs),
  limit = MAX_QUESTION_COMPUTATIONS,
): readonly AdaptiveQuestion[] {
  let computationCount = 0;
  const questions: AdaptiveQuestion[] = [];
  const unresolved = new Set(inputs.plan.missingFacts);
  const definitions = inputs.model.factDefinitions
    .filter(
      (definition) =>
        unresolved.has(definition.key) &&
        inputs.userState.facts[definition.key] === undefined &&
        factAlternatives(definition).length > 0,
    )
    .sort((left, right) => left.key.localeCompare(right.key));

  for (const definition of definitions) {
    const alternatives: QuestionAlternative[] = [];
    for (const value of factAlternatives(definition)) {
      if (computationCount >= limit) break;
      computationCount += 1;
      const hypothetical = hypotheticalPlan(inputs, definition.key, value);
      alternatives.push({
        value,
        planStatus: hypothetical.plan.status,
        actionDecision: decisionById(hypothetical.evaluation, actionId).status,
        routeActionIds: hypothetical.plan.steps.map((step) => step.procedureActionId),
        unresolvedFacts: hypothetical.plan.missingFacts,
      });
    }
    if (alternatives.length === 0) continue;
    const distinctOutcomeCount = new Set(alternatives.map(outcomeKey)).size;
    const resolvedBranches = alternatives.filter(
      (alternative) => !alternative.unresolvedFacts.includes(definition.key),
    ).length;
    const materiallyDifferent = distinctOutcomeCount > 1;
    questions.push({
      factKey: definition.key,
      label: definition.label,
      alternatives,
      distinctOutcomeCount,
      priorityScore:
        (materiallyDifferent ? 100 : 0) + distinctOutcomeCount * 10 + resolvedBranches,
      whyItMatters: materiallyDifferent
        ? `Different answers produce ${distinctOutcomeCount} distinct evaluated outcomes.`
        : "Each valid answer resolves this fact, but the evaluated outcome is otherwise unchanged.",
    });
    if (computationCount >= limit) break;
  }

  return questions.sort(
    (left, right) =>
      right.priorityScore - left.priorityScore || left.factKey.localeCompare(right.factKey),
  );
}

export function analyzeDecisionIntelligence(inputs: DecisionInputs): DecisionIntelligence {
  const selectedActionId = selectDecisionAction(inputs);
  const counterfactuals = analyzeCounterfactuals(inputs, selectedActionId);
  const questions = rankAdaptiveQuestions(inputs, selectedActionId);
  const nextQuestion = questions[0];
  return {
    selectedActionId,
    trace: buildDecisionTrace(inputs, selectedActionId),
    counterfactuals,
    questions,
    ...(nextQuestion === undefined ? {} : { nextQuestion }),
    computationCount:
      counterfactuals.length +
      questions.reduce((total, question) => total + question.alternatives.length, 0),
  };
}
