type JsonSchema = Readonly<Record<string, unknown>>;

const idSchema = { type: "string", pattern: "^[a-z]+_[a-zA-Z0-9_-]{6,}$" } as const;
const factKeySchema = { type: "string", pattern: "^[a-z][a-zA-Z0-9_.-]*$" } as const;
const scalarSchema = {
  oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
} as const;

const alwaysCondition = {
  type: "object",
  properties: { kind: { const: "always" } },
  required: ["kind"],
  additionalProperties: false,
} as const;

const factCondition = {
  type: "object",
  properties: {
    kind: { const: "fact" },
    fact: factKeySchema,
    op: { enum: ["eq", "neq", "in", "not_in", "lt", "lte", "gt", "gte"] },
    value: {
      oneOf: [scalarSchema, { type: "array", items: scalarSchema, minItems: 1 }],
    },
  },
  required: ["kind", "fact", "op", "value"],
  additionalProperties: false,
} as const;

function conditionSchema(depth: number): JsonSchema {
  const variants: unknown[] = [alwaysCondition, factCondition];
  if (depth > 0) {
    const childReference = { $ref: `#/$defs/condition${depth - 1}` };
    variants.push(
      {
        type: "object",
        properties: {
          kind: { const: "all" },
          conditions: { type: "array", items: childReference, minItems: 1 },
        },
        required: ["kind", "conditions"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: { const: "any" },
          conditions: { type: "array", items: childReference, minItems: 1 },
        },
        required: ["kind", "conditions"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { kind: { const: "not" }, condition: childReference },
        required: ["kind", "condition"],
        additionalProperties: false,
      },
    );
  }
  return { oneOf: variants };
}

const citationSchema = {
  type: "object",
  properties: {
    pageId: idSchema,
    pageUrl: { type: "string", format: "uri" },
    blockId: idSchema,
    excerpt: { type: "string" },
    actionIds: { type: "array", items: idSchema },
  },
  required: ["pageId", "pageUrl", "blockId", "excerpt", "actionIds"],
  additionalProperties: false,
} as const;

const ruleBaseProperties = {
  id: idSchema,
  actionId: idSchema,
  appliesWhen: { $ref: "#/$defs/condition4" },
  citations: { type: "array", items: { $ref: "#/$defs/citation" }, minItems: 1 },
  semanticConfidence: { type: "number" },
  needsReview: { type: "boolean" },
  reviewReason: { type: "string" },
} as const;

const ruleBaseRequired = [
  "id",
  "actionId",
  "effect",
  "appliesWhen",
  "citations",
  "semanticConfidence",
  "needsReview",
] as const;

function ruleSchema(effect: "permit" | "prohibit" | "require_condition" | "require_action"): JsonSchema {
  const effectProperties: Readonly<Record<string, unknown>> =
    effect === "require_condition"
      ? { requirement: { $ref: "#/$defs/condition4" } }
      : effect === "require_action"
        ? { requiredActionId: idSchema }
        : {};
  const effectRequired =
    effect === "require_condition"
      ? ["requirement"]
      : effect === "require_action"
        ? ["requiredActionId"]
        : [];
  return {
    type: "object",
    properties: { ...ruleBaseProperties, effect: { const: effect }, ...effectProperties },
    required: [...ruleBaseRequired, ...effectRequired],
    additionalProperties: false,
  };
}

const browserActionSchema = {
  type: "object",
  properties: {
    id: idSchema,
    kind: { enum: ["navigate", "interact"] },
    label: { type: "string" },
    description: { type: "string" },
    websiteActionId: idSchema,
    prerequisiteActionIds: { type: "array", items: idSchema },
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
} as const;

const userTaskSchema = {
  type: "object",
  properties: {
    id: idSchema,
    kind: { const: "user_task" },
    label: { type: "string" },
    description: { type: "string" },
    prerequisiteActionIds: { type: "array", items: idSchema },
    terminal: { type: "boolean" },
  },
  required: ["id", "kind", "label", "description", "prerequisiteActionIds", "terminal"],
  additionalProperties: false,
} as const;

/**
 * Anthropic structured outputs do not support recursive JSON schemas. The API-facing
 * grammar therefore permits four compound condition levels; canonical Zod parsing
 * remains authoritative and can represent deeper saved/replayed models.
 */
export const PROCEDURE_MODEL_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    schemaVersion: { const: 1 },
    id: idSchema,
    sourceSnapshotId: idSchema,
    sourceSnapshotHash: { type: "string" },
    extractedAt: { type: "string", format: "date-time" },
    goalSummary: { type: "string" },
    factDefinitions: {
      type: "array",
      items: { $ref: "#/$defs/factDefinition" },
    },
    actions: { type: "array", items: { $ref: "#/$defs/procedureAction" }, minItems: 1 },
    goalActionIds: { type: "array", items: idSchema, minItems: 1 },
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
    "rules",
  ],
  additionalProperties: false,
  $defs: {
    condition0: conditionSchema(0),
    condition1: conditionSchema(1),
    condition2: conditionSchema(2),
    condition3: conditionSchema(3),
    condition4: conditionSchema(4),
    citation: citationSchema,
    procedureAction: { oneOf: [browserActionSchema, userTaskSchema] },
    factDefinition: {
      type: "object",
      properties: {
        key: factKeySchema,
        label: { type: "string" },
        type: { enum: ["string", "number", "boolean"] },
        allowedValues: { type: "array", items: scalarSchema, minItems: 1 },
        sensitive: { const: false },
      },
      required: ["key", "label", "type", "sensitive"],
      additionalProperties: false,
    },
    rule: {
      oneOf: [
        ruleSchema("permit"),
        ruleSchema("prohibit"),
        ruleSchema("require_condition"),
        ruleSchema("require_action"),
      ],
    },
  },
};

