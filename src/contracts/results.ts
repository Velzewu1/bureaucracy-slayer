import { z } from "zod";

import { FactKeySchema, HashSchema, HttpUrlSchema, IdSchema, IsoDateTimeSchema } from "./primitives.js";

export const EvidenceIssueCodeSchema = z.enum([
  "SCHEMA_INVALID",
  "SNAPSHOT_MISMATCH",
  "PAGE_MISSING",
  "BLOCK_MISSING",
  "EXCERPT_MISMATCH",
  "ACTION_MISSING",
  "ACTION_UNAVAILABLE",
  "CROSS_ORIGIN_BLOCKED",
  "REFERENCE_INVALID",
  "DEPENDENCY_CYCLE",
  "SEMANTIC_REVIEW_REQUIRED",
]);

export const EvidenceIssueSchema = z
  .object({
    severity: z.enum(["warning", "error"]),
    code: EvidenceIssueCodeSchema,
    message: z.string().min(1),
    ruleId: IdSchema.optional(),
    procedureActionId: IdSchema.optional(),
  })
  .strict();

export const EvidenceResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdSchema,
    snapshotId: IdSchema,
    snapshotHash: HashSchema,
    procedureModelId: IdSchema,
    checkedAt: IsoDateTimeSchema,
    status: z.enum(["valid", "degraded", "invalid"]),
    validRuleIds: z.array(IdSchema),
    rejectedRuleIds: z.array(IdSchema),
    verifiedWebsiteActionIds: z.array(IdSchema),
    executableProcedureActionIds: z.array(IdSchema),
    issues: z.array(EvidenceIssueSchema),
  })
  .strict();

export const TruthValueSchema = z.enum(["true", "false", "unknown"]);
export const ConditionEvaluationSchema = z
  .object({
    value: TruthValueSchema,
    missingFacts: z.array(FactKeySchema),
    reasonCodes: z.array(z.enum(["MISSING_FACT", "TYPE_MISMATCH"])),
  })
  .strict();

export const ActionDecisionStatusSchema = z.enum(["allowed", "forbidden", "indeterminate", "review"]);
export const ActionEvaluationSchema = z
  .object({
    actionId: IdSchema,
    status: ActionDecisionStatusSchema,
    reasonCodes: z.array(z.string()),
    missingFacts: z.array(FactKeySchema),
    citationRuleIds: z.array(IdSchema),
    requiredActionIds: z.array(IdSchema),
  })
  .strict();

export const EvaluationResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    procedureModelId: IdSchema,
    evidenceResultId: IdSchema,
    userStateRevision: z.number().int().nonnegative(),
    status: z.enum(["evaluated", "review_required", "stale"]),
    decisions: z.array(ActionEvaluationSchema),
    reasonCodes: z.array(z.string()),
  })
  .strict();

export const SafePlanStepSchema = z
  .object({
    index: z.number().int().positive(),
    procedureActionId: IdSchema,
    websiteActionId: IdSchema.optional(),
    pageId: IdSchema.optional(),
    url: HttpUrlSchema.optional(),
    instruction: z.string().min(1),
    citationRuleIds: z.array(IdSchema).min(1),
    requiresUserConfirmation: z.boolean(),
    autoExecutable: z.literal(false),
  })
  .strict();

export const SafeActionPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdSchema,
    generatedAt: IsoDateTimeSchema,
    status: z.enum(["ready", "needs_information", "blocked", "review_required", "stale"]),
    snapshotId: IdSchema,
    snapshotHash: HashSchema,
    procedureModelId: IdSchema,
    evidenceResultId: IdSchema,
    userStateRevision: z.number().int().nonnegative(),
    userStateHash: HashSchema,
    steps: z.array(SafePlanStepSchema),
    missingFacts: z.array(FactKeySchema),
    reasonCodes: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict();

export type EvidenceIssueCode = z.infer<typeof EvidenceIssueCodeSchema>;
export type EvidenceIssue = z.infer<typeof EvidenceIssueSchema>;
export type EvidenceResult = z.infer<typeof EvidenceResultSchema>;
export type TruthValue = z.infer<typeof TruthValueSchema>;
export type ConditionEvaluation = z.infer<typeof ConditionEvaluationSchema>;
export type ActionEvaluation = z.infer<typeof ActionEvaluationSchema>;
export type EvaluationResult = z.infer<typeof EvaluationResultSchema>;
export type SafePlanStep = z.infer<typeof SafePlanStepSchema>;
export type SafeActionPlan = z.infer<typeof SafeActionPlanSchema>;

