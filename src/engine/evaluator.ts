import {
  EvaluationResultSchema,
  type ActionEvaluation,
  type ConditionEvaluation,
  type EvaluationResult,
  type EvidenceResult,
  type ProcedureModel,
  type UserState,
} from "../contracts/index.js";

import { evaluateCondition } from "./conditions.js";

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function hasTypeMismatch(result: ConditionEvaluation): boolean {
  return result.reasonCodes.includes("TYPE_MISMATCH");
}

export function evaluatePolicies(
  model: ProcedureModel,
  evidence: EvidenceResult,
  userState: UserState,
): EvaluationResult {
  const bindingReasonCodes: string[] = [];
  if (evidence.procedureModelId !== model.id) bindingReasonCodes.push("MODEL_EVIDENCE_MISMATCH");
  if (evidence.snapshotId !== model.sourceSnapshotId || evidence.snapshotHash !== model.sourceSnapshotHash) {
    bindingReasonCodes.push("SNAPSHOT_EVIDENCE_MISMATCH");
  }
  if (bindingReasonCodes.length > 0) {
    return EvaluationResultSchema.parse({
      schemaVersion: 1,
      procedureModelId: model.id,
      evidenceResultId: evidence.id,
      userStateRevision: userState.revision,
      status: "stale",
      decisions: [],
      reasonCodes: uniqueSorted(bindingReasonCodes),
    });
  }

  const validRules = new Set(evidence.validRuleIds);
  const rejectedRules = new Set(evidence.rejectedRuleIds);
  const usableRules = new Set(
    model.rules
      .filter((rule) => validRules.has(rule.id) && !rejectedRules.has(rule.id))
      .map((rule) => rule.id),
  );
  const executableActions = new Set(evidence.executableProcedureActionIds);
  const decisions: ActionEvaluation[] = [];

  for (const action of [...model.actions].sort((left, right) => left.id.localeCompare(right.id))) {
    const actionRules = model.rules.filter((rule) => rule.actionId === action.id);
    const rejectedActionRules = actionRules.filter((rule) => !usableRules.has(rule.id));
    const reasonCodes: string[] = [];
    const missingFacts: string[] = [];
    const citationRuleIds: string[] = [];
    const requiredActionIds: string[] = [];
    let activePermits = 0;
    let possiblePermits = 0;
    let activeProhibitions = 0;
    let possibleProhibitions = 0;
    let failedRequirements = 0;
    let unknownRequirements = 0;
    let typeMismatch = false;

    for (const rule of actionRules) {
      if (!usableRules.has(rule.id)) continue;
      const applicability = evaluateCondition(rule.appliesWhen, userState.facts);
      missingFacts.push(...applicability.missingFacts);
      typeMismatch ||= hasTypeMismatch(applicability);
      if (applicability.value === "false") continue;

      if (rule.effect === "permit") {
        if (applicability.value === "true") {
          activePermits += 1;
          citationRuleIds.push(rule.id);
        } else {
          possiblePermits += 1;
        }
        continue;
      }
      if (rule.effect === "prohibit") {
        if (applicability.value === "true") {
          activeProhibitions += 1;
          citationRuleIds.push(rule.id);
        } else {
          possibleProhibitions += 1;
        }
        continue;
      }
      if (applicability.value === "unknown") {
        unknownRequirements += 1;
        continue;
      }
      if (rule.effect === "require_action") {
        requiredActionIds.push(rule.requiredActionId);
        citationRuleIds.push(rule.id);
        continue;
      }
      const requirement = evaluateCondition(rule.requirement, userState.facts);
      missingFacts.push(...requirement.missingFacts);
      typeMismatch ||= hasTypeMismatch(requirement);
      if (requirement.value === "true") citationRuleIds.push(rule.id);
      else if (requirement.value === "false") failedRequirements += 1;
      else unknownRequirements += 1;
    }

    let status: ActionEvaluation["status"];
    if (evidence.status === "invalid" || !executableActions.has(action.id) || rejectedActionRules.length > 0 || typeMismatch) {
      status = "review";
      if (evidence.status === "invalid") reasonCodes.push("EVIDENCE_INVALID");
      if (!executableActions.has(action.id)) reasonCodes.push("ACTION_UNVERIFIED");
      if (rejectedActionRules.length > 0) reasonCodes.push("EVIDENCE_REJECTED");
      if (typeMismatch) reasonCodes.push("FACT_TYPE_MISMATCH");
    } else if (activeProhibitions > 0 && activePermits > 0) {
      status = "review";
      reasonCodes.push("POLICY_CONFLICT", "PROHIBITED");
    } else if (activeProhibitions > 0) {
      status = "forbidden";
      reasonCodes.push("PROHIBITED");
    } else if (possibleProhibitions > 0 || unknownRequirements > 0) {
      status = "indeterminate";
      reasonCodes.push("MISSING_FACTS");
    } else if (failedRequirements > 0) {
      status = "forbidden";
      reasonCodes.push("REQUIREMENT_FAILED");
    } else if (activePermits > 0) {
      status = "allowed";
      reasonCodes.push("PERMITTED");
    } else if (possiblePermits > 0) {
      status = "indeterminate";
      reasonCodes.push("MISSING_FACTS");
    } else {
      status = "forbidden";
      reasonCodes.push("NOT_PERMITTED");
    }

    decisions.push({
      actionId: action.id,
      status,
      reasonCodes: uniqueSorted(reasonCodes),
      missingFacts: uniqueSorted(missingFacts),
      citationRuleIds: uniqueSorted(citationRuleIds),
      requiredActionIds: uniqueSorted(requiredActionIds),
    });
  }

  return EvaluationResultSchema.parse({
    schemaVersion: 1,
    procedureModelId: model.id,
    evidenceResultId: evidence.id,
    userStateRevision: userState.revision,
    status: evidence.status === "invalid" ? "review_required" : "evaluated",
    decisions,
    reasonCodes: evidence.status === "invalid" ? ["EVIDENCE_INVALID"] : [],
  });
}

