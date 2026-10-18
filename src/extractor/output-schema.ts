type JsonSchema = Readonly<Record<string, unknown>>;

const stringSchema = { type: "string" } as const;
const stringArraySchema = { type: "array", items: stringSchema } as const;

/**
 * API-facing extraction shape. It deliberately avoids unions and nested condition
 * objects so Anthropic's constrained-output compiler receives a small grammar.
 * Keep identifier constraints out of this grammar: the deterministic converter
 * rejects empty, malformed, and cross-namespace references before canonical parsing.
 */
export const COMPACT_EXTRACTION_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    schemaVersion: { const: 1 },
    id: stringSchema,
    sourceSnapshotId: stringSchema,
    sourceSnapshotHash: stringSchema,
    extractedAt: stringSchema,
    goalSummary: stringSchema,
    factDefinitions: { type: "array", items: { $ref: "#/$defs/factDefinition" } },
    actions: { type: "array", items: { $ref: "#/$defs/action" } },
    goalActionIds: stringArraySchema,
    conditionNodes: { type: "array", items: { $ref: "#/$defs/conditionNode" } },
    rules: { type: "array", items: { $ref: "#/$defs/rule" } },
  },
  required: [
    "schemaVersion",
    "id",
    "sourceSnapshotId",
    "sourceSnapshotHash",
    "extractedAt",
    "goalSummary",
    "factDefinitions",
    "actions",
    "goalActionIds",
    "conditionNodes",
    "rules",
  ],
  additionalProperties: false,
  $defs: {
    factDefinition: {
      type: "object",
      properties: {
        key: stringSchema,
        label: stringSchema,
        type: { enum: ["string", "number", "boolean"] },
        allowedValuesJson: stringSchema,
        sensitive: { const: false },
      },
      required: ["key", "label", "type", "allowedValuesJson", "sensitive"],
      additionalProperties: false,
    },
    action: {
      type: "object",
      properties: {
        id: stringSchema,
        kind: { enum: ["navigate", "interact", "user_task"] },
        label: stringSchema,
        description: stringSchema,
        websiteActionId: stringSchema,
        prerequisiteActionIds: stringArraySchema,
        terminal: { type: "boolean" },
      },
      required: [
        "id",
        "kind",
        "label",
        "description",
        "websiteActionId",
        "prerequisiteActionIds",
        "terminal",
      ],
      additionalProperties: false,
    },
    conditionNode: {
      type: "object",
      properties: {
        id: stringSchema,
        kind: { enum: ["always", "fact", "all", "any", "not"] },
        fact: stringSchema,
        op: { enum: ["", "eq", "neq", "in", "not_in", "lt", "lte", "gt", "gte"] },
        valueJson: stringSchema,
        childIds: stringArraySchema,
      },
      required: ["id", "kind", "fact", "op", "valueJson", "childIds"],
      additionalProperties: false,
    },
    citation: {
      type: "object",
      properties: {
        pageId: stringSchema,
        pageUrl: stringSchema,
        blockId: stringSchema,
        excerpt: stringSchema,
        websiteActionIds: stringArraySchema,
      },
      required: ["pageId", "pageUrl", "blockId", "excerpt", "websiteActionIds"],
      additionalProperties: false,
    },
    rule: {
      type: "object",
      properties: {
        id: stringSchema,
        actionId: stringSchema,
        effect: { enum: ["permit", "prohibit", "require_condition", "require_action"] },
        appliesWhenConditionId: stringSchema,
        requirementConditionId: stringSchema,
        requiredActionId: stringSchema,
        citations: { type: "array", items: { $ref: "#/$defs/citation" } },
        semanticConfidence: { type: "number" },
        needsReview: { type: "boolean" },
        reviewReason: stringSchema,
      },
      required: [
        "id",
        "actionId",
        "effect",
        "appliesWhenConditionId",
        "requirementConditionId",
        "requiredActionId",
        "citations",
        "semanticConfidence",
        "needsReview",
        "reviewReason",
      ],
      additionalProperties: false,
    },
  },
};

// Preserve the existing exported name used by request construction and callers.
export const PROCEDURE_MODEL_OUTPUT_SCHEMA = COMPACT_EXTRACTION_OUTPUT_SCHEMA;

/** Stage 1: policy semantics and provenance only, with no procedure graph IDs. */
export const POLICY_EXTRACTION_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    schemaVersion: { const: 1 },
    policyAnalysisId: stringSchema,
    sourceSnapshotId: stringSchema,
    sourceSnapshotHash: stringSchema,
    factDefinitions: { type: "array", items: { $ref: "#/$defs/factDefinition" } },
    conditionNodes: { type: "array", items: { $ref: "#/$defs/conditionNode" } },
    rules: { type: "array", items: { $ref: "#/$defs/policyRule" } },
  },
  required: [
    "schemaVersion",
    "policyAnalysisId",
    "sourceSnapshotId",
    "sourceSnapshotHash",
    "factDefinitions",
    "conditionNodes",
    "rules",
  ],
  additionalProperties: false,
  $defs: {
    factDefinition: {
      type: "object",
      properties: {
        key: stringSchema,
        label: stringSchema,
        type: { enum: ["string", "number", "boolean"] },
        allowedValuesJson: stringSchema,
        sensitive: { const: false },
      },
      required: ["key", "label", "type", "allowedValuesJson", "sensitive"],
      additionalProperties: false,
    },
    conditionNode: {
      type: "object",
      properties: {
        id: stringSchema,
        kind: { enum: ["always", "fact", "all", "any", "not"] },
        fact: stringSchema,
        op: { enum: ["", "eq", "neq", "in", "not_in", "lt", "lte", "gt", "gte"] },
        valueJson: stringSchema,
        childIds: stringArraySchema,
      },
      required: ["id", "kind", "fact", "op", "valueJson", "childIds"],
      additionalProperties: false,
    },
    citation: {
      type: "object",
      properties: {
        pageId: stringSchema,
        pageUrl: stringSchema,
        blockId: stringSchema,
        excerpt: stringSchema,
        websiteActionIds: stringArraySchema,
      },
      required: ["pageId", "pageUrl", "blockId", "excerpt", "websiteActionIds"],
      additionalProperties: false,
    },
    policyRule: {
      type: "object",
      properties: {
        id: stringSchema,
        effect: { enum: ["permit", "prohibit", "require_condition", "require_action"] },
        actionPurpose: stringSchema,
        appliesWhenConditionId: stringSchema,
        requirementConditionId: stringSchema,
        requiredActionPurpose: stringSchema,
        qualifierConditionIds: stringArraySchema,
        citations: { type: "array", items: { $ref: "#/$defs/citation" } },
        semanticConfidence: { type: "number" },
        needsReview: { type: "boolean" },
        reviewReason: stringSchema,
      },
      required: [
        "id",
        "effect",
        "actionPurpose",
        "appliesWhenConditionId",
        "requirementConditionId",
        "requiredActionPurpose",
        "qualifierConditionIds",
        "citations",
        "semanticConfidence",
        "needsReview",
        "reviewReason",
      ],
      additionalProperties: false,
    },
  },
};

/** Stage 2: procedure graph plus an explicit mapping for every Stage 1 rule. */
export const PROCEDURE_MAPPING_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    schemaVersion: { const: 1 },
    id: stringSchema,
    sourceSnapshotId: stringSchema,
    sourceSnapshotHash: stringSchema,
    extractedAt: stringSchema,
    goalSummary: stringSchema,
    actions: { type: "array", items: { $ref: "#/$defs/action" } },
    goalActionIds: stringArraySchema,
    ruleMappings: { type: "array", items: { $ref: "#/$defs/ruleMapping" } },
  },
  required: [
    "schemaVersion",
    "id",
    "sourceSnapshotId",
    "sourceSnapshotHash",
    "extractedAt",
    "goalSummary",
    "actions",
    "goalActionIds",
    "ruleMappings",
  ],
  additionalProperties: false,
  $defs: {
    action: {
      type: "object",
      properties: {
        id: stringSchema,
        kind: { enum: ["navigate", "interact", "user_task"] },
        label: stringSchema,
        description: stringSchema,
        websiteActionId: stringSchema,
        prerequisiteActionIds: stringArraySchema,
        terminal: { type: "boolean" },
      },
      required: [
        "id",
        "kind",
        "label",
        "description",
        "websiteActionId",
        "prerequisiteActionIds",
        "terminal",
      ],
      additionalProperties: false,
    },
    ruleMapping: {
      type: "object",
      properties: {
        policyRuleId: stringSchema,
        actionId: stringSchema,
        requiredActionId: stringSchema,
      },
      required: ["policyRuleId", "actionId", "requiredActionId"],
      additionalProperties: false,
    },
  },
};
