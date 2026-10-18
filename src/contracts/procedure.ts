import { z } from "zod";

import {
  FactKeySchema,
  HashSchema,
  HttpUrlSchema,
  IdSchema,
  IsoDateTimeSchema,
  JsonScalarSchema,
} from "./primitives.js";

export const AtomicConditionSchema = z
  .object({
    kind: z.literal("fact"),
    fact: FactKeySchema,
    op: z.enum(["eq", "neq", "in", "not_in", "lt", "lte", "gt", "gte"]),
    value: z.union([JsonScalarSchema, z.array(JsonScalarSchema).min(1)]),
  })
  .strict()
  .superRefine((condition, context) => {
    const expectsArray = condition.op === "in" || condition.op === "not_in";
    if (expectsArray !== Array.isArray(condition.value)) {
      context.addIssue({
        code: "custom",
        message: expectsArray ? `${condition.op} expects an array value` : `${condition.op} expects a scalar value`,
        path: ["value"],
      });
    }
    if (["lt", "lte", "gt", "gte"].includes(condition.op) && typeof condition.value !== "number") {
      context.addIssue({ code: "custom", message: `${condition.op} expects a numeric value`, path: ["value"] });
    }
  });

const AlwaysConditionSchema = z.object({ kind: z.literal("always") }).strict();

type RecursivePolicyCondition =
  | z.infer<typeof AlwaysConditionSchema>
  | z.infer<typeof AtomicConditionSchema>
  | { kind: "all"; conditions: RecursivePolicyCondition[] }
  | { kind: "any"; conditions: RecursivePolicyCondition[] }
  | { kind: "not"; condition: RecursivePolicyCondition };

export const PolicyConditionSchema: z.ZodType<RecursivePolicyCondition> = z.lazy(() =>
  z.union([
    AlwaysConditionSchema,
    AtomicConditionSchema,
    z.object({ kind: z.literal("all"), conditions: z.array(PolicyConditionSchema).min(1) }).strict(),
    z.object({ kind: z.literal("any"), conditions: z.array(PolicyConditionSchema).min(1) }).strict(),
    z.object({ kind: z.literal("not"), condition: PolicyConditionSchema }).strict(),
  ]),
);

export const EvidenceCitationSchema = z
  .object({
    pageId: IdSchema,
    pageUrl: HttpUrlSchema,
    blockId: IdSchema,
    excerpt: z.string().min(1).max(1000),
    actionIds: z.array(IdSchema).default([]),
  })
  .strict();

const RuleBaseSchema = z
  .object({
    id: IdSchema,
    actionId: IdSchema,
    appliesWhen: PolicyConditionSchema,
    citations: z.array(EvidenceCitationSchema).min(1),
    semanticConfidence: z.number().min(0).max(1),
    needsReview: z.boolean(),
    reviewReason: z.string().min(1).optional(),
  })
  .strict();

export const PolicyRuleSchema = z.discriminatedUnion("effect", [
  RuleBaseSchema.extend({ effect: z.literal("permit") }),
  RuleBaseSchema.extend({ effect: z.literal("prohibit") }),
  RuleBaseSchema.extend({ effect: z.literal("require_condition"), requirement: PolicyConditionSchema }),
  RuleBaseSchema.extend({ effect: z.literal("require_action"), requiredActionId: IdSchema }),
]);

export const ProcedureActionSchema = z
  .object({
    id: IdSchema,
    kind: z.enum(["navigate", "interact", "user_task"]),
    label: z.string().min(1),
    description: z.string().min(1),
    websiteActionId: IdSchema.optional(),
    prerequisiteActionIds: z.array(IdSchema).default([]),
    terminal: z.boolean().default(false),
  })
  .strict()
  .superRefine((action, context) => {
    if (action.kind === "user_task" && action.websiteActionId !== undefined) {
      context.addIssue({ code: "custom", message: "user_task must not have a websiteActionId" });
    }
    if (action.kind !== "user_task" && action.websiteActionId === undefined) {
      context.addIssue({ code: "custom", message: `${action.kind} requires a websiteActionId` });
    }
  });

export const UserFactDefinitionSchema = z
  .object({
    key: FactKeySchema,
    label: z.string().min(1),
    type: z.enum(["string", "number", "boolean"]),
    allowedValues: z.array(JsonScalarSchema).min(1).optional(),
    sensitive: z.literal(false),
  })
  .strict();

export const ProcedureModelSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdSchema,
    sourceSnapshotId: IdSchema,
    sourceSnapshotHash: HashSchema,
    extractedAt: IsoDateTimeSchema,
    goalSummary: z.string().min(1),
    factDefinitions: z.array(UserFactDefinitionSchema),
    actions: z.array(ProcedureActionSchema).min(1),
    goalActionIds: z.array(IdSchema).min(1),
    rules: z.array(PolicyRuleSchema),
  })
  .strict()
  .superRefine((model, context) => {
    const actionIds = new Set(model.actions.map((action) => action.id));
    const ruleIds = new Set<string>();
    const factKeys = new Set<string>();

    if (actionIds.size !== model.actions.length) {
      context.addIssue({ code: "custom", message: "Procedure action ids must be unique" });
    }
    for (const action of model.actions) {
      for (const prerequisiteId of action.prerequisiteActionIds) {
        if (!actionIds.has(prerequisiteId)) {
          context.addIssue({ code: "custom", message: `Unknown prerequisite action: ${prerequisiteId}` });
        }
      }
    }
    for (const goalActionId of model.goalActionIds) {
      if (!actionIds.has(goalActionId)) {
        context.addIssue({ code: "custom", message: `Unknown goal action: ${goalActionId}` });
      }
    }
    for (const rule of model.rules) {
      if (ruleIds.has(rule.id)) {
        context.addIssue({ code: "custom", message: `Duplicate rule id: ${rule.id}` });
      }
      ruleIds.add(rule.id);
      if (!actionIds.has(rule.actionId)) {
        context.addIssue({ code: "custom", message: `Rule ${rule.id} targets unknown action ${rule.actionId}` });
      }
      if (rule.effect === "require_action" && !actionIds.has(rule.requiredActionId)) {
        context.addIssue({ code: "custom", message: `Rule ${rule.id} requires unknown action ${rule.requiredActionId}` });
      }
      if (rule.needsReview && rule.reviewReason === undefined) {
        context.addIssue({ code: "custom", message: `Rule ${rule.id} needs a reviewReason` });
      }
    }
    for (const definition of model.factDefinitions) {
      if (factKeys.has(definition.key)) {
        context.addIssue({ code: "custom", message: `Duplicate fact definition: ${definition.key}` });
      }
      factKeys.add(definition.key);
    }
  });

export const UserStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    facts: z.record(z.string(), JsonScalarSchema),
  })
  .strict();

export type AtomicCondition = z.infer<typeof AtomicConditionSchema>;
export type PolicyCondition = z.infer<typeof PolicyConditionSchema>;
export type EvidenceCitation = z.infer<typeof EvidenceCitationSchema>;
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type ProcedureAction = z.infer<typeof ProcedureActionSchema>;
export type ProcedureModel = z.infer<typeof ProcedureModelSchema>;
export type UserState = z.infer<typeof UserStateSchema>;
