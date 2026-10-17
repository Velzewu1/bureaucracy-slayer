import {
  SafeActionPlanSchema,
  hashCanonical,
  type ActionEvaluation,
  type EvaluationResult,
  type EvidenceResult,
  type ProcedureAction,
  type ProcedureModel,
  type SafeActionPlan,
  type SafePlanStep,
  type UserState,
} from "../contracts/index.js";

export type PlannerContext = Readonly<{
  planId: string;
  generatedAt: string;
  userStateHash: string;
}>;

type RouteStatus = "ready" | "needs_information" | "blocked" | "review_required";
type Route = Readonly<{
  goalActionId: string;
  status: RouteStatus;
  orderedActionIds: readonly string[];
  missingFacts: readonly string[];
  reasonCodes: readonly string[];
  steps: readonly SafePlanStep[];
  userTaskCount: number;
}>;

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function basePlan(
  model: ProcedureModel,
  evidence: EvidenceResult,
  userState: UserState,
  context: PlannerContext,
  status: SafeActionPlan["status"],
  reasonCodes: readonly string[],
): SafeActionPlan {
  return SafeActionPlanSchema.parse({
    schemaVersion: 1,
    id: context.planId,
    generatedAt: context.generatedAt,
    status,
    snapshotId: evidence.snapshotId,
    snapshotHash: evidence.snapshotHash,
    procedureModelId: model.id,
    evidenceResultId: evidence.id,
    userStateRevision: userState.revision,
    userStateHash: context.userStateHash,
    steps: [],
    missingFacts: [],
    reasonCodes: uniqueSorted(reasonCodes),
    warnings: [],
  });
}

function routeRank(left: Route, right: Route): number {
  return (
    left.orderedActionIds.length - right.orderedActionIds.length ||
    left.userTaskCount - right.userTaskCount ||
    left.goalActionId.localeCompare(right.goalActionId) ||
    left.orderedActionIds.join("|").localeCompare(right.orderedActionIds.join("|"))
  );
}

function buildRoute(
  goalActionId: string,
  actions: ReadonlyMap<string, ProcedureAction>,
  decisions: ReadonlyMap<string, ActionEvaluation>,
  executableActions: ReadonlySet<string>,
): Route {
  const orderedActionIds: string[] = [];
  const permanent = new Set<string>();
  const visiting = new Set<string>();
  const graphReasons: string[] = [];

  function visit(actionId: string): void {
    if (permanent.has(actionId)) return;
    if (visiting.has(actionId)) {
      graphReasons.push("DEPENDENCY_CYCLE");
      return;
    }
    const action = actions.get(actionId);
    const decision = decisions.get(actionId);
    if (action === undefined || decision === undefined) {
      graphReasons.push("MISSING_PREREQUISITE");
      return;
    }
    visiting.add(actionId);
    const dependencies = uniqueSorted([...action.prerequisiteActionIds, ...decision.requiredActionIds]);
    for (const dependencyId of dependencies) visit(dependencyId);
    visiting.delete(actionId);
    permanent.add(actionId);
    orderedActionIds.push(actionId);
  }

  visit(goalActionId);
  const routeDecisions = orderedActionIds
    .map((actionId) => decisions.get(actionId))
    .filter((decision): decision is ActionEvaluation => decision !== undefined);
  const reasonCodes = [
    ...graphReasons,
    ...routeDecisions
      .filter((decision) => decision.status !== "allowed")
      .flatMap((decision) => decision.reasonCodes),
  ];
  const missingFacts = uniqueSorted(routeDecisions.flatMap((decision) => decision.missingFacts));
  const containsUnverifiedAction = orderedActionIds.some((actionId) => !executableActions.has(actionId));

  let status: RouteStatus;
  if (graphReasons.length > 0 || containsUnverifiedAction || routeDecisions.some((decision) => decision.status === "review")) {
    status = "review_required";
    if (containsUnverifiedAction) reasonCodes.push("ACTION_UNVERIFIED");
  } else if (routeDecisions.some((decision) => decision.status === "forbidden")) {
    status = "blocked";
  } else if (routeDecisions.some((decision) => decision.status === "indeterminate")) {
    status = "needs_information";
  } else {
    status = "ready";
  }

  const steps: SafePlanStep[] = [];
  if (status === "ready") {
    for (const [index, actionId] of orderedActionIds.entries()) {
      const action = actions.get(actionId);
      const decision = decisions.get(actionId);
      if (action === undefined || decision === undefined || decision.citationRuleIds.length === 0) {
        return {
          goalActionId,
          status: "review_required",
          orderedActionIds,
          missingFacts,
          reasonCodes: uniqueSorted([...reasonCodes, "MISSING_STEP_PROVENANCE"]),
          steps: [],
          userTaskCount: orderedActionIds.filter((id) => actions.get(id)?.kind === "user_task").length,
        };
      }
      steps.push({
        index: index + 1,
        procedureActionId: action.id,
        ...(action.websiteActionId === undefined ? {} : { websiteActionId: action.websiteActionId }),
        instruction: action.description,
        citationRuleIds: decision.citationRuleIds,
        requiresUserConfirmation: true,
        autoExecutable: false,
      });
    }
  }

  return {
    goalActionId,
    status,
    orderedActionIds,
    missingFacts,
    reasonCodes: uniqueSorted(reasonCodes),
    steps,
    userTaskCount: orderedActionIds.filter((id) => actions.get(id)?.kind === "user_task").length,
  };
}

export function planActions(
  model: ProcedureModel,
  evidence: EvidenceResult,
  evaluation: EvaluationResult,
  userState: UserState,
  context: PlannerContext,
): SafeActionPlan {
  const staleReasonCodes: string[] = [];
  const bindingsAreStale =
    evidence.procedureModelId !== model.id ||
    evidence.snapshotId !== model.sourceSnapshotId ||
    evidence.snapshotHash !== model.sourceSnapshotHash ||
    evaluation.procedureModelId !== model.id ||
    evaluation.evidenceResultId !== evidence.id ||
    evaluation.userStateRevision !== userState.revision ||
    evaluation.status === "stale";
  if (bindingsAreStale) staleReasonCodes.push("ARTIFACT_MISMATCH");
  if (context.userStateHash !== hashCanonical(userState)) staleReasonCodes.push("USER_STATE_HASH_MISMATCH");
  if (staleReasonCodes.length > 0) {
    return basePlan(model, evidence, userState, context, "stale", staleReasonCodes);
  }
  if (evidence.status === "invalid" || evaluation.status === "review_required") {
    return basePlan(model, evidence, userState, context, "review_required", ["EVIDENCE_INVALID"]);
  }

  const actions = new Map(model.actions.map((action) => [action.id, action]));
  const decisions = new Map(evaluation.decisions.map((decision) => [decision.actionId, decision]));
  const executableActions = new Set(evidence.executableProcedureActionIds);
  const routes = [...model.goalActionIds]
    .sort()
    .map((goalActionId) => buildRoute(goalActionId, actions, decisions, executableActions));

  const readyRoutes = routes.filter((route) => route.status === "ready").sort(routeRank);
  if (readyRoutes.length > 0) {
    const selected = readyRoutes[0];
    if (selected === undefined) throw new Error("Ready route selection invariant failed");
    const rejectedWarnings = routes
      .filter((route) => route.goalActionId !== selected.goalActionId && route.status !== "ready")
      .map((route) => `Route ${route.goalActionId} was ${route.status}: ${route.reasonCodes.join(", ")}`)
      .sort();
    return SafeActionPlanSchema.parse({
      ...basePlan(model, evidence, userState, context, "ready", ["ROUTE_READY"]),
      steps: selected.steps,
      reasonCodes: ["ROUTE_READY"],
      warnings: rejectedWarnings,
    });
  }

  const precedence: readonly RouteStatus[] = ["needs_information", "review_required", "blocked"];
  for (const status of precedence) {
    const candidates = routes.filter((route) => route.status === status).sort(routeRank);
    const selected = candidates[0];
    if (selected !== undefined) {
      return SafeActionPlanSchema.parse({
        ...basePlan(model, evidence, userState, context, status, selected.reasonCodes),
        missingFacts: selected.missingFacts,
      });
    }
  }

  return basePlan(model, evidence, userState, context, "blocked", ["NO_ROUTE"]);
}

