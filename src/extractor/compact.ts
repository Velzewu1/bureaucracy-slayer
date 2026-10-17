import { z } from "zod";

import {
  JsonScalarSchema,
  ProcedureModelSchema,
  type JsonScalar,
  type PolicyCondition,
  type ProcedureModel,
  type SiteSnapshot,
} from "../contracts/index.js";

const FactOperatorSchema = z.enum(["", "eq", "neq", "in", "not_in", "lt", "lte", "gt", "gte"]);
const ConditionKindSchema = z.enum(["always", "fact", "all", "any", "not"]);

export const CompactFactDefinitionSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    type: z.enum(["string", "number", "boolean"]),
    allowedValuesJson: z.string(),
    sensitive: z.literal(false),
  })
  .strict();

export const CompactActionSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["navigate", "interact", "user_task"]),
    label: z.string(),
    description: z.string(),
    websiteActionId: z.string(),
    prerequisiteActionIds: z.array(z.string()),
    terminal: z.boolean(),
  })
  .strict();

export const CompactConditionNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: ConditionKindSchema,
    fact: z.string(),
    op: FactOperatorSchema,
    valueJson: z.string(),
    childIds: z.array(z.string()),
  })
  .strict();

export const CompactCitationSchema = z
  .object({
    pageId: z.string(),
    pageUrl: z.string(),
    blockId: z.string(),
    excerpt: z.string(),
    websiteActionIds: z.array(z.string()),
  })
  .strict();

const CompactRuleSchema = z
  .object({
    id: z.string(),
    actionId: z.string(),
    effect: z.enum(["permit", "prohibit", "require_condition", "require_action"]),
    appliesWhenConditionId: z.string(),
    requirementConditionId: z.string(),
    requiredActionId: z.string(),
    citations: z.array(CompactCitationSchema),
    semanticConfidence: z.number(),
    needsReview: z.boolean(),
    reviewReason: z.string(),
  })
  .strict();

export const CompactExtractionDTOSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string(),
    sourceSnapshotId: z.string(),
    sourceSnapshotHash: z.string(),
    extractedAt: z.string(),
    goalSummary: z.string(),
    factDefinitions: z.array(CompactFactDefinitionSchema),
    actions: z.array(CompactActionSchema),
    goalActionIds: z.array(z.string()),
    conditionNodes: z.array(CompactConditionNodeSchema),
    rules: z.array(CompactRuleSchema),
  })
  .strict();

export type CompactExtractionDTO = z.infer<typeof CompactExtractionDTOSchema>;

export type CompactConversionNormalization = Readonly<{
  code: "CROSS_PAGE_TARGET_ACTION_OMITTED";
  ruleId: string;
  citationPageId: string;
  websiteActionId: string;
  websiteActionPageId: string;
  message: string;
}>;

export type CompactConversionOutcome =
  | Readonly<{
      ok: true;
      model: ProcedureModel;
      normalizations: readonly CompactConversionNormalization[];
    }>
  | Readonly<{
      ok: false;
      stage: "compact_schema" | "conversion" | "canonical_schema";
      issues: readonly string[];
      normalizations: readonly CompactConversionNormalization[];
    }>;

type CompactConditionNode = z.infer<typeof CompactConditionNodeSchema>;
type FactType = z.infer<typeof CompactFactDefinitionSchema>["type"];
type FactOperator = Exclude<z.infer<typeof FactOperatorSchema>, "">;

export type CompactAllowedValuesOutcome =
  | Readonly<{ ok: true; allowedValues?: readonly JsonScalar[] }>
  | Readonly<{ ok: false; reason: "invalid_json" | "non_empty_scalar_array" | "type_mismatch" }>;

const MAX_COMPOUND_DEPTH = 4;
const FACT_OPERATORS = new Set<FactOperator>([
  "eq",
  "neq",
  "in",
  "not_in",
  "lt",
  "lte",
  "gt",
  "gte",
]);

function zodIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);
}

function parseJson(value: string, path: string, addIssue: (issue: string) => void): unknown {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    addIssue(`${path} must contain valid JSON.`);
    return undefined;
  }
}

function scalarMatchesType(value: JsonScalar, type: FactType): boolean {
  return typeof value === type;
}

/**
 * The compact DTO keeps this field always present to avoid an API-schema union.
 * Empty string is the legacy absence sentinel. For booleans only, the explicit
 * JSON empty-array sentinel also means that canonical allowedValues is omitted.
 */
export function decodeCompactAllowedValues(
  definition: Readonly<{ type: FactType; allowedValuesJson: string }>,
): CompactAllowedValuesOutcome {
  if (definition.allowedValuesJson.length === 0) return { ok: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(definition.allowedValuesJson);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (definition.type === "boolean" && Array.isArray(parsed) && parsed.length === 0) {
    return { ok: true };
  }
  const valuesResult = z.array(JsonScalarSchema).min(1).safeParse(parsed);
  if (!valuesResult.success) return { ok: false, reason: "non_empty_scalar_array" };
  if (valuesResult.data.some((value) => !scalarMatchesType(value, definition.type))) {
    return { ok: false, reason: "type_mismatch" };
  }
  return { ok: true, allowedValues: valuesResult.data };
}

function isFactOperator(value: z.infer<typeof FactOperatorSchema>): value is FactOperator {
  return value !== "" && FACT_OPERATORS.has(value);
}

/**
 * Converts Claude's compact, grammar-safe DTO into the canonical contract. The
 * conversion is pure and never repairs arbitrary references, conditions, or policy
 * effects. It records and omits only a rule target WebsiteAction copied into a
 * citation for a different page; that binding remains on the ProcedureAction.
 */
export function convertCompactExtraction(
  input: unknown,
  snapshot: SiteSnapshot,
): CompactConversionOutcome {
  const dtoResult = CompactExtractionDTOSchema.safeParse(input);
  if (!dtoResult.success) {
    return {
      ok: false,
      stage: "compact_schema",
      issues: zodIssues(dtoResult.error),
      normalizations: [],
    };
  }

  const dto = dtoResult.data;
  const issueSet = new Set<string>();
  const normalizations: CompactConversionNormalization[] = [];
  const addIssue = (issue: string): void => {
    issueSet.add(issue);
  };

  if (dto.sourceSnapshotId !== snapshot.id || dto.sourceSnapshotHash !== snapshot.contentHash) {
    addIssue("sourceSnapshotId and sourceSnapshotHash must exactly match the supplied snapshot.");
  }

  const pages = new Map(snapshot.pages.map((page) => [page.id, page]));
  const websiteActions = new Map(
    snapshot.pages.flatMap((page) => page.actions.map((action) => [action.id, { action, page }] as const)),
  );

  const factTypes = new Map<string, FactType>();
  const factDefinitions: Array<Record<string, unknown>> = [];
  for (const definition of dto.factDefinitions) {
    if (factTypes.has(definition.key)) addIssue(`Duplicate fact definition: ${definition.key}.`);
    else factTypes.set(definition.key, definition.type);

    const decodedAllowedValues = decodeCompactAllowedValues(definition);
    let allowedValues: readonly JsonScalar[] | undefined;
    if (!decodedAllowedValues.ok) {
      if (decodedAllowedValues.reason === "invalid_json") {
        addIssue(`factDefinitions.${definition.key}.allowedValuesJson must contain valid JSON.`);
      } else if (decodedAllowedValues.reason === "non_empty_scalar_array") {
        addIssue(`factDefinitions.${definition.key}.allowedValuesJson must encode a non-empty scalar array.`);
      } else {
        addIssue(`Allowed values do not match the declared type of ${definition.key}.`);
      }
    } else {
      allowedValues = decodedAllowedValues.allowedValues;
    }
    factDefinitions.push({
      key: definition.key,
      label: definition.label,
      type: definition.type,
      ...(allowedValues === undefined ? {} : { allowedValues }),
      sensitive: definition.sensitive,
    });
  }

  const actions: Array<Record<string, unknown>> = [];
  const procedureActions = new Map<string, CompactExtractionDTO["actions"][number]>();
  const representedWebsiteActionIds = new Set<string>();
  for (const action of dto.actions) {
    if (procedureActions.has(action.id)) addIssue(`Duplicate procedure action: ${action.id}.`);
    else procedureActions.set(action.id, action);

    if (action.kind === "user_task") {
      if (action.websiteActionId.length > 0) {
        addIssue(`User task ${action.id} must use an empty websiteActionId.`);
      }
    } else if (action.websiteActionId.length === 0) {
      addIssue(`Browser-backed action ${action.id} requires a websiteActionId.`);
    } else if (!websiteActions.has(action.websiteActionId)) {
      addIssue(`Action ${action.id} references unsupported website action ${action.websiteActionId}.`);
    } else {
      representedWebsiteActionIds.add(action.websiteActionId);
    }

    actions.push({
      id: action.id,
      kind: action.kind,
      label: action.label,
      description: action.description,
      ...(action.websiteActionId.length === 0 ? {} : { websiteActionId: action.websiteActionId }),
      prerequisiteActionIds: action.prerequisiteActionIds,
      terminal: action.terminal,
    });
  }

  const conditionNodes = new Map<string, CompactConditionNode>();
  for (const node of dto.conditionNodes) {
    if (conditionNodes.has(node.id)) addIssue(`Duplicate condition node: ${node.id}.`);
    else conditionNodes.set(node.id, node);
  }

  function buildCondition(
    nodeId: string,
    compoundDepth: number,
    ancestors: ReadonlySet<string>,
    referenceContext: string,
  ): PolicyCondition | undefined {
    if (nodeId.trim().length === 0) {
      addIssue(`${referenceContext} is empty; expected a condition node ID.`);
      return undefined;
    }
    const node = conditionNodes.get(nodeId);
    if (node === undefined) {
      addIssue(`${referenceContext} references unknown condition node ${JSON.stringify(nodeId)}.`);
      return undefined;
    }
    if (ancestors.has(nodeId)) {
      addIssue(`Condition cycle includes ${nodeId}.`);
      return undefined;
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(nodeId);
    const hasUnusedFactFields = node.fact.length > 0 || node.op.length > 0 || node.valueJson.length > 0;

    switch (node.kind) {
      case "always":
        if (hasUnusedFactFields || node.childIds.length > 0) {
          addIssue(`Always condition ${node.id} contains unsupported fields.`);
          return undefined;
        }
        return { kind: "always" };
      case "fact": {
        if (node.childIds.length > 0) {
          addIssue(`Fact condition ${node.id} must not contain childIds.`);
          return undefined;
        }
        if (node.fact.length === 0 || !isFactOperator(node.op) || node.valueJson.length === 0) {
          addIssue(`Fact condition ${node.id} requires fact, op, and valueJson.`);
          return undefined;
        }
        const factType = factTypes.get(node.fact);
        if (factType === undefined) {
          addIssue(`Condition ${node.id} references undeclared fact ${node.fact}.`);
          return undefined;
        }
        const parsedValue = parseJson(node.valueJson, `conditionNodes.${node.id}.valueJson`, addIssue);
        const expectsArray = node.op === "in" || node.op === "not_in";
        const valueResult = expectsArray
          ? z.array(JsonScalarSchema).min(1).safeParse(parsedValue)
          : JsonScalarSchema.safeParse(parsedValue);
        if (!valueResult.success) {
          addIssue(
            `Condition ${node.id} ${expectsArray ? "requires a non-empty scalar array" : "requires a scalar"} valueJson.`,
          );
          return undefined;
        }
        const values = Array.isArray(valueResult.data) ? valueResult.data : [valueResult.data];
        if (values.some((value) => !scalarMatchesType(value, factType))) {
          addIssue(`Condition ${node.id} value does not match fact ${node.fact}.`);
          return undefined;
        }
        if (["lt", "lte", "gt", "gte"].includes(node.op) && typeof valueResult.data !== "number") {
          addIssue(`Condition ${node.id} comparison ${node.op} requires a number.`);
          return undefined;
        }
        return { kind: "fact", fact: node.fact, op: node.op, value: valueResult.data };
      }
      case "all":
      case "any": {
        if (hasUnusedFactFields || node.childIds.length === 0) {
          addIssue(`${node.kind} condition ${node.id} requires childIds and empty fact fields.`);
          return undefined;
        }
        if (compoundDepth >= MAX_COMPOUND_DEPTH) {
          addIssue(`Condition ${node.id} exceeds ${MAX_COMPOUND_DEPTH} compound levels.`);
          return undefined;
        }
        const children = node.childIds.map((childId, index) =>
          buildCondition(
            childId,
            compoundDepth + 1,
            nextAncestors,
            `Condition ${node.id} childIds[${index}]`,
          ),
        );
        if (children.some((child) => child === undefined)) return undefined;
        const conditions = children.filter((child): child is PolicyCondition => child !== undefined);
        return node.kind === "all" ? { kind: "all", conditions } : { kind: "any", conditions };
      }
      case "not": {
        if (hasUnusedFactFields || node.childIds.length !== 1) {
          addIssue(`Not condition ${node.id} requires exactly one childId and empty fact fields.`);
          return undefined;
        }
        if (compoundDepth >= MAX_COMPOUND_DEPTH) {
          addIssue(`Condition ${node.id} exceeds ${MAX_COMPOUND_DEPTH} compound levels.`);
          return undefined;
        }
        const childId = node.childIds[0];
        if (childId === undefined) return undefined;
        const condition = buildCondition(
          childId,
          compoundDepth + 1,
          nextAncestors,
          `Condition ${node.id} childIds[0]`,
        );
        return condition === undefined ? undefined : { kind: "not", condition };
      }
    }
  }

  // Validate every node, including unused nodes, so malformed hidden expressions
  // cannot be ignored during conversion.
  for (const nodeId of conditionNodes.keys()) {
    buildCondition(nodeId, 0, new Set(), `Condition node ${nodeId}`);
  }

  const rules: Array<Record<string, unknown>> = [];
  for (const rule of dto.rules) {
    const targetProcedureAction = procedureActions.get(rule.actionId);
    const appliesWhen = buildCondition(
      rule.appliesWhenConditionId,
      0,
      new Set(),
      `Rule ${rule.id} appliesWhenConditionId`,
    );
    let requirement: PolicyCondition | undefined;

    if (rule.effect === "require_condition") {
      if (rule.requirementConditionId.length === 0 || rule.requiredActionId.length > 0) {
        addIssue(`Rule ${rule.id} must provide only requirementConditionId for require_condition.`);
      } else {
        requirement = buildCondition(
          rule.requirementConditionId,
          0,
          new Set(),
          `Rule ${rule.id} requirementConditionId`,
        );
      }
    } else if (rule.effect === "require_action") {
      if (rule.requiredActionId.length === 0 || rule.requirementConditionId.length > 0) {
        addIssue(`Rule ${rule.id} must provide only requiredActionId for require_action.`);
      }
    } else if (rule.requirementConditionId.length > 0 || rule.requiredActionId.length > 0) {
      addIssue(`Rule ${rule.id} must leave effect-specific reference fields empty.`);
    }

    if (rule.needsReview && rule.reviewReason.length === 0) {
      addIssue(`Rule ${rule.id} needs a reviewReason.`);
    }

    if (!procedureActions.has(rule.actionId)) {
      addIssue(`Rule ${rule.id} targets undeclared procedure action ${rule.actionId}.`);
    }
    if (rule.effect === "require_action" && !procedureActions.has(rule.requiredActionId)) {
      addIssue(`Rule ${rule.id} requires undeclared procedure action ${rule.requiredActionId}.`);
    }

    for (const citation of rule.citations) {
      const page = pages.get(citation.pageId);
      if (page === undefined) {
        addIssue(`Rule ${rule.id} references unsupported page ${citation.pageId}.`);
        continue;
      }
      if (citation.pageUrl !== page.url) {
        addIssue(`Rule ${rule.id} citation URL does not match page ${citation.pageId}.`);
      }
      if (!page.blocks.some((block) => block.id === citation.blockId)) {
        addIssue(`Rule ${rule.id} references unsupported block ${citation.blockId}.`);
      }
      for (const websiteActionId of citation.websiteActionIds) {
        const binding = websiteActions.get(websiteActionId);
        if (binding === undefined) {
          addIssue(
            procedureActions.has(websiteActionId)
              ? `Rule ${rule.id} citation uses procedure action ${websiteActionId} where a WebsiteAction ID is required.`
              : `Rule ${rule.id} citation references unobserved WebsiteAction ${websiteActionId}.`,
          );
          continue;
        }
        if (binding.page.id !== page.id) {
          if (
            targetProcedureAction !== undefined &&
            targetProcedureAction.kind !== "user_task" &&
            targetProcedureAction.websiteActionId === websiteActionId
          ) {
            normalizations.push({
              code: "CROSS_PAGE_TARGET_ACTION_OMITTED",
              ruleId: rule.id,
              citationPageId: page.id,
              websiteActionId,
              websiteActionPageId: binding.page.id,
              message:
                `Rule ${rule.id} copied its target WebsiteAction ${websiteActionId} into a citation ` +
                `for page ${page.id}; the citation-local reference was omitted while the ProcedureAction binding was preserved.`,
            });
            continue;
          }
          addIssue(
            `Rule ${rule.id} citation WebsiteAction ${websiteActionId} belongs to page ${binding.page.id}, not cited page ${page.id}.`,
          );
          continue;
        }
        if (!representedWebsiteActionIds.has(websiteActionId)) {
          addIssue(
            `Rule ${rule.id} citation WebsiteAction ${websiteActionId} is not represented by a declared browser procedure action.`,
          );
        }
      }
    }

    if (appliesWhen === undefined) continue;
    const citations = rule.citations.map((citation) => ({
      pageId: citation.pageId,
      pageUrl: citation.pageUrl,
      blockId: citation.blockId,
      excerpt: citation.excerpt,
      actionIds: citation.websiteActionIds.filter((websiteActionId) => {
        const binding = websiteActions.get(websiteActionId);
        return !(
          binding !== undefined &&
          binding.page.id !== citation.pageId &&
          targetProcedureAction !== undefined &&
          targetProcedureAction.kind !== "user_task" &&
          targetProcedureAction.websiteActionId === websiteActionId
        );
      }),
    }));
    const base = {
      id: rule.id,
      actionId: rule.actionId,
      effect: rule.effect,
      appliesWhen,
      citations,
      semanticConfidence: rule.semanticConfidence,
      needsReview: rule.needsReview,
      ...(rule.reviewReason.length === 0 ? {} : { reviewReason: rule.reviewReason }),
    };
    if (rule.effect === "require_condition") {
      if (requirement !== undefined) rules.push({ ...base, requirement });
    } else if (rule.effect === "require_action") {
      rules.push({ ...base, requiredActionId: rule.requiredActionId });
    } else {
      rules.push(base);
    }
  }

  const conversionIssues = [...issueSet];
  if (conversionIssues.length > 0) {
    return { ok: false, stage: "conversion", issues: conversionIssues, normalizations };
  }

  const canonicalResult = ProcedureModelSchema.safeParse({
    schemaVersion: dto.schemaVersion,
    id: dto.id,
    sourceSnapshotId: dto.sourceSnapshotId,
    sourceSnapshotHash: dto.sourceSnapshotHash,
    extractedAt: dto.extractedAt,
    goalSummary: dto.goalSummary,
    factDefinitions,
    actions,
    goalActionIds: dto.goalActionIds,
    rules,
  });
  if (!canonicalResult.success) {
    return {
      ok: false,
      stage: "canonical_schema",
      issues: zodIssues(canonicalResult.error),
      normalizations,
    };
  }
  return { ok: true, model: canonicalResult.data, normalizations };
}
