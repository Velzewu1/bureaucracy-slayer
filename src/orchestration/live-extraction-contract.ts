import { z } from "zod";

import { HttpUrlSchema, IdSchema, IsoDateTimeSchema } from "../contracts/primitives.js";
import { ProcedureModelSchema } from "../contracts/procedure.js";
import { EvidenceResultSchema } from "../contracts/results.js";
import { SiteSnapshotSchema } from "../contracts/snapshot.js";

export const LIVE_EXTRACTION_START_ROUTE = "/api/live-extraction/jobs";
export const LIVE_EXTRACTION_POLL_INTERVAL_MS = 1_000;
export const LIVE_EXTRACTION_MAX_REQUEST_BODY_BYTES = 1_024;
export const LIVE_EXTRACTION_JOB_TIMEOUT_MS = 180_000;
export const LIVE_EXTRACTION_TERMINAL_RETENTION_MS = 15 * 60_000;

export const LiveExtractionJobIdSchema = z.string().regex(/^job_[a-f0-9]{32}$/u);
export const LiveExtractionRequestIdSchema = z.string().regex(/^request_[a-f0-9]{32}$/u);
export const LiveExtractionClientStopReasonSchema = z.enum([
  "user_cancelled",
  "navigation",
  "mode_changed",
  "component_unmounted",
]);

const SourceCountsSchema = z
  .object({
    pages: z.number().int().nonnegative(),
    blocks: z.number().int().nonnegative(),
    actions: z.number().int().nonnegative(),
  })
  .strict();

export const LiveSourceSelectionSummarySchema = z
  .object({
    sourceSnapshotId: IdSchema,
    sourceSnapshotHash: z.string().min(8),
    userGoal: z.string().trim().min(1).max(2_000),
    selectionMode: z.literal("goal_scoped"),
    semanticCoverage: z.literal("not_verified"),
    coverage: z.literal("complete"),
    limitations: z.array(z.string().min(1).max(500)).max(0),
    originalCounts: SourceCountsSchema,
    selectedCounts: SourceCountsSchema,
    selectedPageIds: z.array(IdSchema),
  })
  .strict()
  .superRefine((selection, context) => {
    if (new Set(selection.selectedPageIds).size !== selection.selectedPageIds.length) {
      context.addIssue({
        code: "custom",
        path: ["selectedPageIds"],
        message: "Selected page IDs must be unique.",
      });
    }
    if (selection.selectedCounts.pages !== selection.selectedPageIds.length) {
      context.addIssue({
        code: "custom",
        path: ["selectedCounts", "pages"],
        message: "The selected page count must match selectedPageIds.",
      });
    }
    for (const key of ["pages", "blocks", "actions"] as const) {
      if (selection.selectedCounts[key] > selection.originalCounts[key]) {
        context.addIssue({
          code: "custom",
          path: ["selectedCounts", key],
          message: `Selected ${key} cannot exceed the original count.`,
        });
      }
    }
  });

export const LiveSemanticAuditFindingSchema = z
  .object({
    ruleId: IdSchema,
    code: z.enum([
      "MISSING_QUALIFIER",
      "NEGATED_QUALIFIER_MISMATCH",
      "UNMODELED_EXCEPTION",
      "AMBIGUOUS_PERMISSION_SCOPE",
      "QUALIFIER_UNCERTAIN",
    ]),
    message: z.string().min(1).max(1_000),
    pageId: IdSchema,
    blockId: IdSchema,
    excerpt: z.string().min(1).max(1_000),
  })
  .strict();

export const LiveSemanticAuditResultSchema = z
  .object({
    findings: z.array(LiveSemanticAuditFindingSchema),
    reviewRequiredRuleIds: z.array(IdSchema),
  })
  .strict();

export const LiveExtractionArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal("live_sonnet_extraction"),
    goal: z.string().trim().min(1).max(2_000),
    portalUrl: HttpUrlSchema,
    sourceSnapshot: SiteSnapshotSchema,
    procedureModel: ProcedureModelSchema,
    evidence: EvidenceResultSchema,
    sourceSelection: LiveSourceSelectionSummarySchema,
    semanticAudit: LiveSemanticAuditResultSchema,
    provenance: z
      .object({
        extractionType: z.literal("live"),
        modelName: z.string().min(1).max(200),
        completedAt: IsoDateTimeSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((artifact, context) => {
    const snapshot = artifact.sourceSnapshot;
    const model = artifact.procedureModel;
    const evidence = artifact.evidence;
    const selection = artifact.sourceSelection;

    if (snapshot.rootUrl !== artifact.portalUrl) {
      context.addIssue({
        code: "custom",
        path: ["sourceSnapshot", "rootUrl"],
        message: "The snapshot root URL must match the server-owned live portal URL.",
      });
    }
    if (selection.userGoal !== artifact.goal) {
      context.addIssue({
        code: "custom",
        path: ["sourceSelection", "userGoal"],
        message: "The source-selection goal must match the returned extraction goal.",
      });
    }
    if (
      model.sourceSnapshotId !== snapshot.id ||
      model.sourceSnapshotHash !== snapshot.contentHash
    ) {
      context.addIssue({
        code: "custom",
        path: ["procedureModel"],
        message: "The procedure model must be bound to the returned source snapshot.",
      });
    }
    if (
      evidence.snapshotId !== snapshot.id ||
      evidence.snapshotHash !== snapshot.contentHash ||
      evidence.procedureModelId !== model.id
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "The evidence result must be bound to the returned snapshot and procedure model.",
      });
    }
    if (
      selection.sourceSnapshotId !== snapshot.id ||
      selection.sourceSnapshotHash !== snapshot.contentHash
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceSelection"],
        message: "The source-selection summary must be bound to the returned snapshot.",
      });
    }

    const pageIds = new Set(snapshot.pages.map((page) => page.id));
    const originalCounts = {
      pages: snapshot.pages.length,
      blocks: snapshot.pages.reduce((count, page) => count + page.blocks.length, 0),
      actions: snapshot.pages.reduce((count, page) => count + page.actions.length, 0),
    };
    for (const key of ["pages", "blocks", "actions"] as const) {
      if (selection.originalCounts[key] !== originalCounts[key]) {
        context.addIssue({
          code: "custom",
          path: ["sourceSelection", "originalCounts", key],
          message: `The original ${key} count must match the returned snapshot.`,
        });
      }
    }
    for (const pageId of selection.selectedPageIds) {
      if (!pageIds.has(pageId)) {
        context.addIssue({
          code: "custom",
          path: ["sourceSelection", "selectedPageIds"],
          message: `The source-selection summary references unknown page ${pageId}.`,
        });
      }
    }

    const blocksById = new Map(
      snapshot.pages.flatMap((page) => page.blocks.map((block) => [block.id, page.id] as const)),
    );
    const ruleIds = new Set(model.rules.map((rule) => rule.id));
    for (const finding of artifact.semanticAudit.findings) {
      if (!ruleIds.has(finding.ruleId)) {
        context.addIssue({
          code: "custom",
          path: ["semanticAudit", "findings"],
          message: `The semantic audit references unknown rule ${finding.ruleId}.`,
        });
      }
      if (blocksById.get(finding.blockId) !== finding.pageId) {
        context.addIssue({
          code: "custom",
          path: ["semanticAudit", "findings"],
          message: `The semantic audit finding for ${finding.ruleId} has an invalid page/block binding.`,
        });
      }
    }
    const findingRuleIds = [
      ...new Set(artifact.semanticAudit.findings.map((finding) => finding.ruleId)),
    ].sort();
    const reviewRuleIds = [...new Set(artifact.semanticAudit.reviewRequiredRuleIds)].sort();
    if (
      findingRuleIds.length !== reviewRuleIds.length ||
      findingRuleIds.some((ruleId, index) => ruleId !== reviewRuleIds[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["semanticAudit", "reviewRequiredRuleIds"],
        message: "Semantic review rule IDs must exactly match the rules named by audit findings.",
      });
    }
  });

export const LiveExtractionStartRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    action: z.literal("start_live_extraction"),
    requestId: LiveExtractionRequestIdSchema,
  })
  .strict();

const JobStatusPathSchema = z.string().regex(/^\/api\/live-extraction\/jobs\/job_[a-f0-9]{32}$/u);

export const LiveExtractionStartResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    jobId: LiveExtractionJobIdSchema,
    state: z.enum(["queued", "running", "succeeded", "failed"]),
    statusUrl: JobStatusPathSchema,
    pollAfterMs: z.literal(LIVE_EXTRACTION_POLL_INTERVAL_MS),
  })
  .strict()
  .superRefine((response, context) => {
    if (response.statusUrl !== `${LIVE_EXTRACTION_START_ROUTE}/${response.jobId}`) {
      context.addIssue({
        code: "custom",
        path: ["statusUrl"],
        message: "The status URL must identify the returned job.",
      });
    }
  });

export const LiveExtractionFailureCodeSchema = z.enum([
  "REQUEST_INVALID",
  "REQUEST_TOO_LARGE",
  "UNSUPPORTED_ACTION",
  "UNSUPPORTED_MEDIA_TYPE",
  "JOB_ALREADY_RUNNING",
  "JOB_NOT_FOUND",
  "JOB_EXPIRED",
  "JOB_TIMED_OUT",
  "CONFIGURATION_INVALID",
  "COLLECTOR_UNAVAILABLE",
  "PORTAL_UNAVAILABLE",
  "COLLECTION_SECURITY_BLOCKED",
  "SNAPSHOT_INVALID",
  "COLLECTION_FAILED",
  "SOURCE_SELECTION_INCOMPLETE",
  "STAGE_1_TRANSPORT_FAILED",
  "STAGE_1_RESPONSE_INVALID",
  "STAGE_1_OUTPUT_INVALID",
  "STAGE_2_TRANSPORT_FAILED",
  "STAGE_2_RESPONSE_INVALID",
  "STAGE_2_OUTPUT_INVALID",
  "PROCEDURE_SCHEMA_INVALID",
  "EVIDENCE_VALIDATION_FAILED",
  "INTERNAL_ERROR",
]);

export const LiveExtractionFailureSchema = z
  .object({
    code: LiveExtractionFailureCodeSchema,
    stage: z.enum([
      "request",
      "job",
      "collector",
      "source_selection",
      "policy_extraction",
      "procedure_mapping",
      "procedure_schema",
      "evidence",
      "timeout",
      "internal",
    ]),
    message: z.string().min(1).max(500),
    retryable: z.boolean(),
    issueCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u)).max(20),
  })
  .strict();

export const LiveExtractionErrorResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    error: LiveExtractionFailureSchema,
  })
  .strict();

const JobBaseShape = {
  schemaVersion: z.literal(1),
  jobId: LiveExtractionJobIdSchema,
  requestId: LiveExtractionRequestIdSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
};

const RunningPhaseSchema = z.enum([
  "collecting",
  "selecting_sources",
  "extracting_policy",
  "mapping_procedure",
  "validating",
]);

export const LiveExtractionJobStatusSchema = z.discriminatedUnion("state", [
  z
    .object({
      ...JobBaseShape,
      state: z.literal("queued"),
      phase: z.literal("queued"),
    })
    .strict(),
  z
    .object({
      ...JobBaseShape,
      state: z.literal("running"),
      phase: RunningPhaseSchema,
      startedAt: IsoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      ...JobBaseShape,
      state: z.literal("succeeded"),
      phase: z.literal("complete"),
      startedAt: IsoDateTimeSchema,
      completedAt: IsoDateTimeSchema,
      expiresAt: IsoDateTimeSchema,
      result: LiveExtractionArtifactSchema,
    })
    .strict(),
  z
    .object({
      ...JobBaseShape,
      state: z.literal("failed"),
      phase: z.literal("failed"),
      startedAt: IsoDateTimeSchema,
      completedAt: IsoDateTimeSchema,
      expiresAt: IsoDateTimeSchema,
      error: LiveExtractionFailureSchema,
    })
    .strict(),
]);

export type LiveSourceSelectionSummary = z.infer<typeof LiveSourceSelectionSummarySchema>;
export type LiveSemanticAuditFinding = z.infer<typeof LiveSemanticAuditFindingSchema>;
export type LiveSemanticAuditResult = z.infer<typeof LiveSemanticAuditResultSchema>;
export type LiveExtractionArtifact = z.infer<typeof LiveExtractionArtifactSchema>;
export type LiveExtractionClientStopReason = z.infer<
  typeof LiveExtractionClientStopReasonSchema
>;
export type LiveExtractionJobId = z.infer<typeof LiveExtractionJobIdSchema>;
export type LiveExtractionRequestId = z.infer<typeof LiveExtractionRequestIdSchema>;
export type LiveExtractionStartRequest = z.infer<typeof LiveExtractionStartRequestSchema>;
export type LiveExtractionStartResponse = z.infer<typeof LiveExtractionStartResponseSchema>;
export type LiveExtractionFailureCode = z.infer<typeof LiveExtractionFailureCodeSchema>;
export type LiveExtractionFailure = z.infer<typeof LiveExtractionFailureSchema>;
export type LiveExtractionErrorResponse = z.infer<typeof LiveExtractionErrorResponseSchema>;
export type LiveExtractionJobStatus = z.infer<typeof LiveExtractionJobStatusSchema>;
