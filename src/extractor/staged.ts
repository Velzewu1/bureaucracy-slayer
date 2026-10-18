import { z } from "zod";

import {
  IdSchema,
  JsonScalarSchema,
  hashCanonical,
  normalizeEvidenceText,
  type JsonScalar,
  type ProcedureModel,
  type SiteSnapshot,
} from "../contracts/index.js";
import {
  CompactActionSchema,
  CompactCitationSchema,
  CompactConditionNodeSchema,
  CompactFactDefinitionSchema,
  decodeCompactAllowedValues,
  convertCompactExtraction,
  type CompactConversionNormalization,
  type CompactExtractionDTO,
} from "./compact.js";
import type { FocusedSourceCatalog } from "./source-selection.js";

const PolicyRuleDTOSchema = z
  .object({
    id: z.string(),
    effect: z.enum(["permit", "prohibit", "require_condition", "require_action"]),
    actionPurpose: z.string(),
    appliesWhenConditionId: z.string(),
    requirementConditionId: z.string(),
    requiredActionPurpose: z.string(),
    qualifierConditionIds: z.array(z.string()),
    citations: z.array(CompactCitationSchema).min(1),
    semanticConfidence: z.number(),
    needsReview: z.boolean(),
    reviewReason: z.string(),
  })
  .strict();

export const PolicyExtractionDTOSchema = z
  .object({
    schemaVersion: z.literal(1),
    policyAnalysisId: z.string(),
    sourceSnapshotId: z.string(),
    sourceSnapshotHash: z.string(),
    factDefinitions: z.array(CompactFactDefinitionSchema),
    conditionNodes: z.array(CompactConditionNodeSchema),
    rules: z.array(PolicyRuleDTOSchema),
  })
  .strict();

const RuleActionMappingDTOSchema = z
  .object({
    policyRuleId: z.string(),
    actionId: z.string(),
    requiredActionId: z.string(),
  })
  .strict();

export const ProcedureMappingDTOSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string(),
    sourceSnapshotId: z.string(),
    sourceSnapshotHash: z.string(),
    extractedAt: z.string(),
    goalSummary: z.string(),
    actions: z.array(CompactActionSchema),
    goalActionIds: z.array(z.string()),
    ruleMappings: z.array(RuleActionMappingDTOSchema),
  })
  .strict();

export type PolicyExtractionDTO = z.infer<typeof PolicyExtractionDTOSchema>;
export type ProcedureMappingDTO = z.infer<typeof ProcedureMappingDTOSchema>;

export type StageValidationOutcome<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; issues: readonly string[] }>;

export type PolicyExtractionNormalization = Readonly<{
  code: "CROSS_PAGE_CITATION_ACTION_OMITTED";
  ruleId: string;
  citationPageId: string;
  websiteActionId: string;
  websiteActionPageId: string;
  message: string;
}>;

export type RuleIdNormalization = Readonly<{
  code: "CANONICAL_RULE_ID_NORMALIZED";
  originalRuleId: string;
  canonicalRuleId: string;
}>;

export type ProcedureModelIdNormalization = Readonly<{
  code: "CANONICAL_PROCEDURE_MODEL_ID_ASSIGNED";
  originalProcedureModelId: string;
  canonicalProcedureModelId: string;
}>;

export type StagedConversionNormalization =
  | CompactConversionNormalization
  | RuleIdNormalization
  | ProcedureModelIdNormalization;

export type RuleIdNormalizationOutcome =
  | Readonly<{
      ok: true;
      policy: PolicyExtractionDTO;
      mapping: ProcedureMappingDTO;
      normalizations: readonly RuleIdNormalization[];
    }>
  | Readonly<{ ok: false; issues: readonly string[] }>;

export type PolicyExtractionAnalysis =
  | Readonly<{
      ok: true;
      value: PolicyExtractionDTO;
      normalizations: readonly PolicyExtractionNormalization[];
    }>
  | Readonly<{
      ok: false;
      issues: readonly string[];
      normalizedDto?: PolicyExtractionDTO;
      normalizations: readonly PolicyExtractionNormalization[];
    }>;

export type StagedConversionOutcome =
  | Readonly<{
      ok: true;
      model: ProcedureModel;
      compactDto: CompactExtractionDTO;
      normalizations: readonly StagedConversionNormalization[];
    }>
  | Readonly<{
      ok: false;
      stage: "policy" | "mapping" | "compact_schema" | "conversion" | "canonical_schema";
      issues: readonly string[];
      compactDto?: CompactExtractionDTO;
      normalizations: readonly StagedConversionNormalization[];
    }>;

function zodIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);
}

const FACT_OPERATORS = new Set(["eq", "neq", "in", "not_in", "lt", "lte", "gt", "gte"]);
const MAX_COMPOUND_DEPTH = 4;

function validatePolicyGraph(
  dto: PolicyExtractionDTO,
  issues: Set<string>,
): ReadonlyMap<string, PolicyExtractionDTO["conditionNodes"][number]> {
  const factTypes = new Map<string, "string" | "number" | "boolean">();
  for (const definition of dto.factDefinitions) {
    if (factTypes.has(definition.key)) issues.add(`Duplicate Stage 1 fact definition: ${definition.key}.`);
    else factTypes.set(definition.key, definition.type);
    const allowedValues = decodeCompactAllowedValues(definition);
    if (!allowedValues.ok) {
      if (allowedValues.reason === "type_mismatch") {
        issues.add(`Stage 1 allowed values do not match fact ${definition.key}.`);
      } else if (allowedValues.reason === "invalid_json") {
        issues.add(`Stage 1 fact ${definition.key} allowedValuesJson must contain valid JSON.`);
      } else {
        issues.add(`Stage 1 fact ${definition.key} allowedValuesJson must encode a non-empty scalar array.`);
      }
    }
  }

  const nodes = new Map<string, PolicyExtractionDTO["conditionNodes"][number]>();
  for (const node of dto.conditionNodes) {
    if (nodes.has(node.id)) issues.add(`Duplicate Stage 1 condition node: ${node.id}.`);
    else nodes.set(node.id, node);
  }

  function visit(nodeId: string, depth: number, ancestors: ReadonlySet<string>): void {
    const node = nodes.get(nodeId);
    if (node === undefined) {
      issues.add(`Stage 1 condition graph references unknown node ${JSON.stringify(nodeId)}.`);
      return;
    }
    if (ancestors.has(nodeId)) {
      issues.add(`Stage 1 condition cycle includes ${nodeId}.`);
      return;
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(nodeId);
    const unusedFactFields = node.fact.length > 0 || node.op.length > 0 || node.valueJson.length > 0;

    if (node.kind === "always") {
      if (unusedFactFields || node.childIds.length > 0) {
        issues.add(`Stage 1 always condition ${node.id} contains unsupported fields.`);
      }
      return;
    }
    if (node.kind === "fact") {
      if (node.childIds.length > 0 || node.fact.length === 0 || !FACT_OPERATORS.has(node.op) || node.valueJson.length === 0) {
        issues.add(`Stage 1 fact condition ${node.id} has malformed fields.`);
        return;
      }
      const factType = factTypes.get(node.fact);
      if (factType === undefined) {
        issues.add(`Stage 1 condition ${node.id} references undeclared fact ${node.fact}.`);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(node.valueJson);
        const expectsArray = node.op === "in" || node.op === "not_in";
        const values = expectsArray
          ? z.array(JsonScalarSchema).min(1).parse(parsed)
          : [JsonScalarSchema.parse(parsed)];
        if (values.some((value: JsonScalar) => typeof value !== factType)) {
          issues.add(`Stage 1 condition ${node.id} value does not match fact ${node.fact}.`);
        }
        if (["lt", "lte", "gt", "gte"].includes(node.op) && typeof parsed !== "number") {
          issues.add(`Stage 1 condition ${node.id} comparison ${node.op} requires a number.`);
        }
      } catch {
        issues.add(`Stage 1 condition ${node.id} valueJson does not match its operator.`);
      }
      return;
    }
    if (unusedFactFields) issues.add(`Stage 1 compound condition ${node.id} contains fact fields.`);
    if (depth >= MAX_COMPOUND_DEPTH) {
      issues.add(`Stage 1 condition ${node.id} exceeds ${MAX_COMPOUND_DEPTH} compound levels.`);
      return;
    }
    if ((node.kind === "all" || node.kind === "any") && node.childIds.length === 0) {
      issues.add(`Stage 1 ${node.kind} condition ${node.id} requires childIds.`);
      return;
    }
    if (node.kind === "not" && node.childIds.length !== 1) {
      issues.add(`Stage 1 not condition ${node.id} requires exactly one childId.`);
      return;
    }
    for (const childId of node.childIds) visit(childId, depth + 1, nextAncestors);
  }

  for (const nodeId of nodes.keys()) visit(nodeId, 0, new Set());
  return nodes;
}

function selectedReferences(catalog: FocusedSourceCatalog): Readonly<{
  pages: ReadonlyMap<string, FocusedSourceCatalog["pages"][number]>;
  actions: ReadonlyMap<string, FocusedSourceCatalog["pages"][number]["actions"][number]>;
}> {
  return {
    pages: new Map(catalog.pages.map((page) => [page.pageId, page])),
    actions: new Map(catalog.pages.flatMap((page) => page.actions.map((action) => [action.websiteActionId, action] as const))),
  };
}

function reachableConditionIds(
  rootId: string,
  nodes: ReadonlyMap<string, PolicyExtractionDTO["conditionNodes"][number]>,
): ReadonlySet<string> {
  const result = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || result.has(id)) continue;
    result.add(id);
    const node = nodes.get(id);
    if (node !== undefined) pending.push(...node.childIds);
  }
  return result;
}

export function analyzePolicyExtraction(
  input: unknown,
  catalog: FocusedSourceCatalog,
): PolicyExtractionAnalysis {
  const parsed = PolicyExtractionDTOSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error), normalizations: [] };
  const references = selectedReferences(catalog);
  const normalizations: PolicyExtractionNormalization[] = [];
  const dto: PolicyExtractionDTO = {
    ...parsed.data,
    rules: parsed.data.rules.map((rule) => ({
      ...rule,
      citations: rule.citations.map((citation) => ({
        ...citation,
        websiteActionIds: citation.websiteActionIds.filter((websiteActionId) => {
          const action = references.actions.get(websiteActionId);
          if (action === undefined || action.pageId === citation.pageId) return true;
          normalizations.push({
            code: "CROSS_PAGE_CITATION_ACTION_OMITTED",
            ruleId: rule.id,
            citationPageId: citation.pageId,
            websiteActionId,
            websiteActionPageId: action.pageId,
            message:
              `Policy rule ${rule.id} attached WebsiteAction ${websiteActionId} from page ${action.pageId} ` +
              `to citation page ${citation.pageId}; the impossible citation-local binding was omitted.`,
          });
          return false;
        }),
      })),
    })),
  };
  const issues = new Set<string>();
  const conditionNodes = validatePolicyGraph(dto, issues);

  if (
    dto.sourceSnapshotId !== catalog.sourceSnapshotId ||
    dto.sourceSnapshotHash !== catalog.sourceSnapshotHash
  ) {
    issues.add("Stage 1 sourceSnapshotId and sourceSnapshotHash must match the focused catalog.");
  }
  if (catalog.coverage !== "complete") {
    issues.add("Stage 1 cannot claim complete policy extraction from incomplete focused-source coverage.");
  }

  const ruleIds = new Set<string>();
  for (const rule of dto.rules) {
    if (ruleIds.has(rule.id)) issues.add(`Duplicate Stage 1 policy rule: ${rule.id}.`);
    ruleIds.add(rule.id);
    if (rule.actionPurpose.trim().length === 0) {
      issues.add(`Policy rule ${rule.id} requires a non-empty actionPurpose.`);
    }
    if (rule.appliesWhenConditionId.trim().length === 0) {
      issues.add(`Policy rule ${rule.id} requires a non-empty appliesWhenConditionId.`);
    } else if (!conditionNodes.has(rule.appliesWhenConditionId)) {
      issues.add(`Policy rule ${rule.id} references unknown appliesWhen condition ${rule.appliesWhenConditionId}.`);
    }
    if (rule.effect === "require_condition") {
      const requirement = conditionNodes.get(rule.requirementConditionId);
      if (rule.requirementConditionId.trim().length === 0 || rule.requiredActionPurpose.length > 0) {
        issues.add(`Policy rule ${rule.id} must provide only requirementConditionId for require_condition.`);
      }
      if (rule.requirementConditionId.trim().length > 0 && requirement === undefined) {
        issues.add(`Policy rule ${rule.id} references unknown requirement condition ${rule.requirementConditionId}.`);
      } else if (requirement?.kind === "always") {
        issues.add(`Policy rule ${rule.id} has a semantically empty require_condition requirement.`);
      }
    } else if (rule.effect === "require_action") {
      if (rule.requiredActionPurpose.trim().length === 0 || rule.requirementConditionId.length > 0) {
        issues.add(`Policy rule ${rule.id} must provide only requiredActionPurpose for require_action.`);
      }
    } else if (rule.requirementConditionId.length > 0 || rule.requiredActionPurpose.length > 0) {
      issues.add(`Policy rule ${rule.id} must leave effect-specific fields empty.`);
    }
    if (rule.needsReview && rule.reviewReason.trim().length === 0) {
      issues.add(`Policy rule ${rule.id} needs a reviewReason.`);
    }
    if (rule.semanticConfidence < 0 || rule.semanticConfidence > 1) {
      issues.add(`Policy rule ${rule.id} semanticConfidence must be between 0 and 1.`);
    }

    const reachable = new Set([
      ...reachableConditionIds(rule.appliesWhenConditionId, conditionNodes),
      ...(rule.effect === "require_condition"
        ? reachableConditionIds(rule.requirementConditionId, conditionNodes)
        : []),
    ]);
    for (const qualifierId of rule.qualifierConditionIds) {
      if (qualifierId.trim().length === 0) {
        issues.add(`Policy rule ${rule.id} contains an empty qualifier condition ID.`);
      } else if (!conditionNodes.has(qualifierId)) {
        issues.add(`Policy rule ${rule.id} references unknown qualifier condition ${qualifierId}.`);
      } else if (!reachable.has(qualifierId)) {
        issues.add(`Policy rule ${rule.id} qualifier ${qualifierId} is not reachable from the rule roots.`);
      }
    }

    for (const citation of rule.citations) {
      const page = references.pages.get(citation.pageId);
      if (page === undefined) {
        issues.add(`Policy rule ${rule.id} cites page ${citation.pageId} outside the focused catalog.`);
        continue;
      }
      if (citation.pageUrl !== page.url) {
        issues.add(`Policy rule ${rule.id} citation URL does not match selected page ${page.pageId}.`);
      }
      const block = page.blocks.find((candidate) => candidate.blockId === citation.blockId);
      if (block === undefined) {
        issues.add(`Policy rule ${rule.id} cites block ${citation.blockId} outside selected page ${page.pageId}.`);
      } else {
        const excerpt = normalizeEvidenceText(citation.excerpt);
        if (excerpt.length === 0 || !normalizeEvidenceText(block.text).includes(excerpt)) {
          issues.add(`Policy rule ${rule.id} citation excerpt does not exactly match block ${citation.blockId}.`);
        }
      }
      for (const websiteActionId of citation.websiteActionIds) {
        const action = references.actions.get(websiteActionId);
        if (action === undefined || action.pageId !== page.pageId) {
          issues.add(
            `Policy rule ${rule.id} citation WebsiteAction ${websiteActionId} is not on cited page ${page.pageId}.`,
          );
        }
      }
    }
  }

  return issues.size === 0
    ? { ok: true, value: dto, normalizations }
    : { ok: false, issues: [...issues], normalizedDto: dto, normalizations };
}

export function validatePolicyExtraction(
  input: unknown,
  catalog: FocusedSourceCatalog,
): StageValidationOutcome<PolicyExtractionDTO> {
  const analysis = analyzePolicyExtraction(input, catalog);
  return analysis.ok
    ? { ok: true, value: analysis.value }
    : { ok: false, issues: analysis.issues };
}

export function validateProcedureMapping(
  input: unknown,
  policy: PolicyExtractionDTO,
  catalog: FocusedSourceCatalog,
): StageValidationOutcome<ProcedureMappingDTO> {
  const parsed = ProcedureMappingDTOSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error) };
  const dto = parsed.data;
  const issues = new Set<string>();
  const references = selectedReferences(catalog);
  const policyRules = new Map(policy.rules.map((rule) => [rule.id, rule]));
  const actions = new Map<string, ProcedureMappingDTO["actions"][number]>();

  if (
    dto.sourceSnapshotId !== catalog.sourceSnapshotId ||
    dto.sourceSnapshotHash !== catalog.sourceSnapshotHash
  ) {
    issues.add("Stage 2 sourceSnapshotId and sourceSnapshotHash must match the focused catalog.");
  }

  // Stage 2 treats citation actions as immutable source provenance, not as an
  // instruction to manufacture ProcedureActions. Recheck their exact catalog
  // identity here so a caller cannot bypass the Stage 1 boundary before join.
  for (const rule of policy.rules) {
    for (const citation of rule.citations) {
      for (const websiteActionId of citation.websiteActionIds) {
        const action = references.actions.get(websiteActionId);
        if (action === undefined || action.pageId !== citation.pageId) {
          issues.add(
            `Stage 2 policy rule ${rule.id} citation WebsiteAction ${websiteActionId} is not on cited page ${citation.pageId}.`,
          );
        }
      }
    }
  }

  for (const action of dto.actions) {
    if (actions.has(action.id)) issues.add(`Duplicate Stage 2 procedure action: ${action.id}.`);
    actions.set(action.id, action);
    if (action.kind === "user_task") {
      if (action.websiteActionId.length > 0) {
        issues.add(`User task ${action.id} must not reference a WebsiteAction.`);
      }
    } else if (!references.actions.has(action.websiteActionId)) {
      issues.add(`Procedure action ${action.id} references WebsiteAction ${action.websiteActionId} outside the focused catalog.`);
    }
  }
  for (const action of dto.actions) {
    for (const prerequisiteActionId of action.prerequisiteActionIds) {
      if (!actions.has(prerequisiteActionId)) {
        issues.add(`Procedure action ${action.id} references undeclared prerequisite ${prerequisiteActionId}.`);
      }
    }
  }
  for (const goalActionId of dto.goalActionIds) {
    if (!actions.has(goalActionId)) issues.add(`Stage 2 references undeclared goal action ${goalActionId}.`);
  }

  const mappings = new Map<string, ProcedureMappingDTO["ruleMappings"][number]>();
  for (const mapping of dto.ruleMappings) {
    if (mappings.has(mapping.policyRuleId)) {
      issues.add(`Duplicate Stage 2 mapping for policy rule ${mapping.policyRuleId}.`);
    }
    mappings.set(mapping.policyRuleId, mapping);
    const policyRule = policyRules.get(mapping.policyRuleId);
    if (policyRule === undefined) {
      issues.add(`Stage 2 maps unknown policy rule ${mapping.policyRuleId}.`);
      continue;
    }
    if (!actions.has(mapping.actionId)) {
      issues.add(`Policy rule ${mapping.policyRuleId} targets undeclared procedure action ${mapping.actionId}.`);
    }
    if (policyRule.effect === "require_action") {
      if (mapping.requiredActionId.length === 0 || !actions.has(mapping.requiredActionId)) {
        issues.add(`Policy rule ${mapping.policyRuleId} requires an undeclared procedure action.`);
      }
    } else if (mapping.requiredActionId.length > 0) {
      issues.add(`Policy rule ${mapping.policyRuleId} must leave requiredActionId empty.`);
    }
  }
  for (const policyRuleId of policyRules.keys()) {
    if (!mappings.has(policyRuleId)) issues.add(`Stage 2 omitted policy rule ${policyRuleId}.`);
  }

  return issues.size === 0 ? { ok: true, value: dto } : { ok: false, issues: [...issues] };
}

function fallbackCanonicalRuleId(sourceId: string): string {
  const bytes = new TextEncoder().encode(sourceId);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `rule_${hex.padEnd(6, "0")}`;
}

function canonicalRuleId(sourceId: string): string {
  if (IdSchema.safeParse(sourceId).success) return sourceId;
  const readableCandidate = `rule_${sourceId}`;
  return IdSchema.safeParse(readableCandidate).success
    ? readableCandidate
    : fallbackCanonicalRuleId(sourceId);
}

/**
 * Rewrites only internal staged rule identifiers. Website/source identifiers,
 * policy semantics, conditions, actions, and citations are left byte-for-byte.
 */
export function normalizeStagedRuleIds(
  policy: PolicyExtractionDTO,
  mapping: ProcedureMappingDTO,
): RuleIdNormalizationOutcome {
  const issues = new Set<string>();
  const sourceIds = new Set<string>();
  const targetIds = new Map<string, string>();
  const reverseTargets = new Map<string, string>();
  const normalizations: RuleIdNormalization[] = [];

  for (const rule of policy.rules) {
    if (sourceIds.has(rule.id)) {
      issues.add(`Cannot normalize duplicate Stage 1 rule ID ${JSON.stringify(rule.id)}.`);
      continue;
    }
    sourceIds.add(rule.id);
    const targetId = canonicalRuleId(rule.id);
    const previousSource = reverseTargets.get(targetId);
    if (previousSource !== undefined && previousSource !== rule.id) {
      issues.add(
        `Rule ID normalization collision: ${JSON.stringify(previousSource)} and ${JSON.stringify(rule.id)} both map to ${JSON.stringify(targetId)}.`,
      );
      continue;
    }
    targetIds.set(rule.id, targetId);
    reverseTargets.set(targetId, rule.id);
    if (targetId !== rule.id) {
      normalizations.push({
        code: "CANONICAL_RULE_ID_NORMALIZED",
        originalRuleId: rule.id,
        canonicalRuleId: targetId,
      });
    }
  }

  for (const reference of mapping.ruleMappings) {
    if (!sourceIds.has(reference.policyRuleId)) {
      issues.add(`Cannot normalize unknown Stage 2 policyRuleId ${JSON.stringify(reference.policyRuleId)}.`);
    }
  }
  if (issues.size > 0) return { ok: false, issues: [...issues] };

  return {
    ok: true,
    policy: {
      ...policy,
      rules: policy.rules.map((rule) => ({ ...rule, id: targetIds.get(rule.id) ?? rule.id })),
    },
    mapping: {
      ...mapping,
      ruleMappings: mapping.ruleMappings.map((reference) => ({
        ...reference,
        policyRuleId: targetIds.get(reference.policyRuleId) ?? reference.policyRuleId,
      })),
    },
    normalizations,
  };
}

const NUMERIC_PREFIX_TECHNICAL_ID = /^[a-z][a-z0-9]*_[a-zA-Z0-9_-]{6,}$/u;

function normalizeProcedureModelId(
  policy: PolicyExtractionDTO,
  mapping: ProcedureMappingDTO,
): Readonly<{
  mapping: ProcedureMappingDTO;
  normalizations: readonly ProcedureModelIdNormalization[];
}> {
  if (IdSchema.safeParse(mapping.id).success || !NUMERIC_PREFIX_TECHNICAL_ID.test(mapping.id)) {
    return { mapping, normalizations: [] };
  }

  // The model id is technical identity assigned before any EvidenceResult,
  // evaluation, or plan exists. Bind its deterministic replacement to both
  // staged identities and the independently validated source snapshot.
  const digest = hashCanonical({
    schemaVersion: 1,
    sourceSnapshotId: mapping.sourceSnapshotId,
    sourceSnapshotHash: mapping.sourceSnapshotHash,
    policyAnalysisId: policy.policyAnalysisId,
    generatedProcedureModelId: mapping.id,
  });
  const canonicalProcedureModelId = `procedure_${digest}`;
  return {
    mapping: { ...mapping, id: canonicalProcedureModelId },
    normalizations: [{
      code: "CANONICAL_PROCEDURE_MODEL_ID_ASSIGNED",
      originalProcedureModelId: mapping.id,
      canonicalProcedureModelId,
    }],
  };
}

export function convertStagedExtraction(
  policyInput: unknown,
  mappingInput: unknown,
  snapshot: SiteSnapshot,
  catalog: FocusedSourceCatalog,
): StagedConversionOutcome {
  const policyResult = validatePolicyExtraction(policyInput, catalog);
  if (!policyResult.ok) {
    return { ok: false, stage: "policy", issues: policyResult.issues, normalizations: [] };
  }
  const mappingResult = validateProcedureMapping(mappingInput, policyResult.value, catalog);
  if (!mappingResult.ok) {
    return { ok: false, stage: "mapping", issues: mappingResult.issues, normalizations: [] };
  }
  const normalized = normalizeStagedRuleIds(policyResult.value, mappingResult.value);
  if (!normalized.ok) {
    return { ok: false, stage: "conversion", issues: normalized.issues, normalizations: [] };
  }
  const policy = normalized.policy;
  const modelIdentity = normalizeProcedureModelId(policy, normalized.mapping);
  const mapping = modelIdentity.mapping;
  const mappings = new Map(mapping.ruleMappings.map((entry) => [entry.policyRuleId, entry]));
  const compactDto: CompactExtractionDTO = {
    schemaVersion: 1,
    id: mapping.id,
    sourceSnapshotId: mapping.sourceSnapshotId,
    sourceSnapshotHash: mapping.sourceSnapshotHash,
    extractedAt: mapping.extractedAt,
    goalSummary: mapping.goalSummary,
    factDefinitions: policy.factDefinitions,
    actions: mapping.actions,
    goalActionIds: mapping.goalActionIds,
    conditionNodes: policy.conditionNodes,
    rules: policy.rules.map((rule) => {
      const actionMapping = mappings.get(rule.id);
      if (actionMapping === undefined) throw new TypeError(`Validated mapping missing ${rule.id}.`);
      return {
        id: rule.id,
        actionId: actionMapping.actionId,
        effect: rule.effect,
        appliesWhenConditionId: rule.appliesWhenConditionId,
        requirementConditionId: rule.requirementConditionId,
        requiredActionId: actionMapping.requiredActionId,
        citations: rule.citations,
        semanticConfidence: rule.semanticConfidence,
        needsReview: rule.needsReview,
        reviewReason: rule.reviewReason,
      };
    }),
  };
  const converted = convertCompactExtraction(compactDto, snapshot);
  if (!converted.ok) {
    return {
      ok: false,
      stage: converted.stage,
      issues: converted.issues,
      compactDto,
      normalizations: [
        ...normalized.normalizations,
        ...modelIdentity.normalizations,
        ...converted.normalizations,
      ],
    };
  }
  return {
    ok: true,
    model: converted.model,
    compactDto,
    normalizations: [
      ...normalized.normalizations,
      ...modelIdentity.normalizations,
      ...converted.normalizations,
    ],
  };
}

// Explicit replay name for loading the focused catalog and both saved DTOs from
// opt-in local diagnostics without issuing another Claude request.
export const replayStagedExtraction = convertStagedExtraction;
