import {
  ProcedureModelSchema,
  type PolicyCondition,
  type ProcedureModel,
} from "../../src/contracts/index.js";
import type { CompactExtractionDTO } from "../../src/extractor/compact.js";
import type {
  PolicyExtractionDTO,
  ProcedureMappingDTO,
} from "../../src/extractor/staged.js";

/** Test-only adapter for feeding canonical fixtures through the API-facing DTO. */
export function compactFixtureFromModel(input: unknown): CompactExtractionDTO {
  const model: ProcedureModel = ProcedureModelSchema.parse(input);
  const conditionNodes: CompactExtractionDTO["conditionNodes"] = [];
  let conditionSequence = 0;

  function addCondition(condition: PolicyCondition): string {
    conditionSequence += 1;
    const id = `condition_node${conditionSequence.toString().padStart(4, "0")}`;
    switch (condition.kind) {
      case "always":
        conditionNodes.push({ id, kind: "always", fact: "", op: "", valueJson: "", childIds: [] });
        break;
      case "fact":
        conditionNodes.push({
          id,
          kind: "fact",
          fact: condition.fact,
          op: condition.op,
          valueJson: JSON.stringify(condition.value),
          childIds: [],
        });
        break;
      case "all":
      case "any": {
        const childIds = condition.conditions.map(addCondition);
        conditionNodes.push({ id, kind: condition.kind, fact: "", op: "", valueJson: "", childIds });
        break;
      }
      case "not": {
        const childId = addCondition(condition.condition);
        conditionNodes.push({ id, kind: "not", fact: "", op: "", valueJson: "", childIds: [childId] });
        break;
      }
    }
    return id;
  }

  const rules = model.rules.map((rule) => ({
    id: rule.id,
    actionId: rule.actionId,
    effect: rule.effect,
    appliesWhenConditionId: addCondition(rule.appliesWhen),
    requirementConditionId: rule.effect === "require_condition" ? addCondition(rule.requirement) : "",
    requiredActionId: rule.effect === "require_action" ? rule.requiredActionId : "",
    citations: rule.citations.map((citation) => ({
      pageId: citation.pageId,
      pageUrl: citation.pageUrl,
      blockId: citation.blockId,
      excerpt: citation.excerpt,
      websiteActionIds: citation.actionIds,
    })),
    semanticConfidence: rule.semanticConfidence,
    needsReview: rule.needsReview,
    reviewReason: rule.reviewReason ?? "",
  }));

  return {
    schemaVersion: model.schemaVersion,
    id: model.id,
    sourceSnapshotId: model.sourceSnapshotId,
    sourceSnapshotHash: model.sourceSnapshotHash,
    extractedAt: model.extractedAt,
    goalSummary: model.goalSummary,
    factDefinitions: model.factDefinitions.map((definition) => ({
      key: definition.key,
      label: definition.label,
      type: definition.type,
      allowedValuesJson:
        definition.allowedValues === undefined ? "" : JSON.stringify(definition.allowedValues),
      sensitive: definition.sensitive,
    })),
    actions: model.actions.map((action) => ({
      id: action.id,
      kind: action.kind,
      label: action.label,
      description: action.description,
      websiteActionId: action.websiteActionId ?? "",
      prerequisiteActionIds: action.prerequisiteActionIds,
      terminal: action.terminal,
    })),
    goalActionIds: model.goalActionIds,
    conditionNodes,
    rules,
  };
}

export function stagedFixturesFromModel(input: unknown): Readonly<{
  policy: PolicyExtractionDTO;
  mapping: ProcedureMappingDTO;
}> {
  const compact = compactFixtureFromModel(input);
  const actionLabels = new Map(compact.actions.map((action) => [action.id, action.label]));
  const nodes = new Map(compact.conditionNodes.map((node) => [node.id, node]));

  function factNodeIds(rootId: string): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const pending = rootId.length === 0 ? [] : [rootId];
    while (pending.length > 0) {
      const id = pending.pop();
      if (id === undefined || visited.has(id)) continue;
      visited.add(id);
      const node = nodes.get(id);
      if (node === undefined) continue;
      if (node.kind === "fact") result.push(id);
      pending.push(...node.childIds);
    }
    return result.sort();
  }

  return {
    policy: {
      schemaVersion: 1,
      policyAnalysisId: "analysis_fixture01",
      sourceSnapshotId: compact.sourceSnapshotId,
      sourceSnapshotHash: compact.sourceSnapshotHash,
      factDefinitions: compact.factDefinitions,
      conditionNodes: compact.conditionNodes,
      rules: compact.rules.map((rule) => ({
        id: rule.id,
        effect: rule.effect,
        actionPurpose: actionLabels.get(rule.actionId) ?? rule.actionId,
        appliesWhenConditionId: rule.appliesWhenConditionId,
        requirementConditionId: rule.requirementConditionId,
        requiredActionPurpose:
          rule.effect === "require_action"
            ? (actionLabels.get(rule.requiredActionId) ?? rule.requiredActionId)
            : "",
        qualifierConditionIds: [
          ...new Set([
            ...factNodeIds(rule.appliesWhenConditionId),
            ...factNodeIds(rule.requirementConditionId),
          ]),
        ],
        citations: rule.citations,
        semanticConfidence: rule.semanticConfidence,
        needsReview: rule.needsReview,
        reviewReason: rule.reviewReason,
      })),
    },
    mapping: {
      schemaVersion: 1,
      id: compact.id,
      sourceSnapshotId: compact.sourceSnapshotId,
      sourceSnapshotHash: compact.sourceSnapshotHash,
      extractedAt: compact.extractedAt,
      goalSummary: compact.goalSummary,
      actions: compact.actions,
      goalActionIds: compact.goalActionIds,
      ruleMappings: compact.rules.map((rule) => ({
        policyRuleId: rule.id,
        actionId: rule.actionId,
        requiredActionId: rule.requiredActionId,
      })),
    },
  };
}
