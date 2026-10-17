import { z } from "zod";

import {
  EvidenceResultSchema,
  IsoDateTimeSchema,
  ProcedureModelSchema,
  SiteSnapshotSchema,
  UserStateSchema,
} from "../contracts/index.js";

const SourceCountsSchema = z
  .object({
    pages: z.number().int().nonnegative(),
    blocks: z.number().int().nonnegative(),
    actions: z.number().int().nonnegative(),
  })
  .strict();

export const RecordedGoalScopeSchema = z
  .object({
    primaryActionPurpose: z.string().trim().min(1),
    alternativeActionPurposes: z.array(z.string().trim().min(1)),
  })
  .strict();

export const RecordedSemanticFindingSchema = z
  .object({
    ruleId: z.string().min(1),
    code: z.enum([
      "MISSING_QUALIFIER",
      "NEGATED_QUALIFIER_MISMATCH",
      "UNMODELED_EXCEPTION",
      "AMBIGUOUS_PERMISSION_SCOPE",
      "QUALIFIER_UNCERTAIN",
    ]),
    message: z.string().min(1),
    pageId: z.string().min(1),
    blockId: z.string().min(1),
    excerpt: z.string().min(1),
  })
  .strict();

export const RecordedExtractionBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    artifactKind: z.literal("sanitized_recorded_sonnet_extraction"),
    extractionGoal: z.string().trim().min(1),
    goalScope: RecordedGoalScopeSchema,
    sourceSnapshot: SiteSnapshotSchema,
    procedureModel: ProcedureModelSchema,
    buildTimeEvidence: EvidenceResultSchema,
    defaultScenario: z
      .object({
        name: z.string().min(1),
        userState: UserStateSchema,
      })
      .strict(),
    sourceSelection: z
      .object({
        selectionMode: z.enum(["general", "goal_scoped"]),
        semanticCoverage: z.literal("not_verified"),
        coverage: z.enum(["complete", "incomplete"]),
        limitations: z.array(z.string()),
        originalCounts: SourceCountsSchema,
        selectedCounts: SourceCountsSchema,
        selectedPageIds: z.array(z.string().min(1)),
      })
      .strict(),
    identity: z
      .object({
        snapshotId: z.string().min(1),
        snapshotHash: z.string().min(1),
        modelId: z.string().min(1),
      })
      .strict(),
    semanticAudit: z
      .object({
        findings: z.array(RecordedSemanticFindingSchema),
        reviewRequiredRuleIds: z.array(z.string().min(1)),
      })
      .strict(),
    provenance: z
      .object({
        extractionType: z.literal("previously_recorded"),
        modelName: z.string().min(1),
        recordedAt: IsoDateTimeSchema,
        sourceArtifacts: z.tuple([
          z.literal("artifacts/live-extraction-debug.json"),
          z.literal("artifacts/live-stage2-resume-2026-10-17T10-00-46-689Z-2d218849.json"),
          z.literal("artifacts/validated-offline-demo-2026-10-17.json"),
        ]),
        stage1Source: z.literal("saved_artifact"),
        stage2Source: z.literal("saved_artifact"),
        policyAnalysisId: z.string().min(1),
        paidCallsDuringReplay: z.literal(0),
      })
      .strict(),
  })
  .strict()
  .superRefine((bundle, context) => {
    if (
      bundle.identity.snapshotId !== bundle.sourceSnapshot.id ||
      bundle.identity.snapshotHash !== bundle.sourceSnapshot.contentHash ||
      bundle.identity.modelId !== bundle.procedureModel.id
    ) {
      context.addIssue({ code: "custom", message: "Bundle identity does not match its artifacts." });
    }
    if (
      bundle.procedureModel.sourceSnapshotId !== bundle.sourceSnapshot.id ||
      bundle.procedureModel.sourceSnapshotHash !== bundle.sourceSnapshot.contentHash
    ) {
      context.addIssue({ code: "custom", message: "Procedure model is not bound to the bundled snapshot." });
    }
    if (
      bundle.buildTimeEvidence.snapshotId !== bundle.sourceSnapshot.id ||
      bundle.buildTimeEvidence.snapshotHash !== bundle.sourceSnapshot.contentHash ||
      bundle.buildTimeEvidence.procedureModelId !== bundle.procedureModel.id
    ) {
      context.addIssue({ code: "custom", message: "Build-time evidence is not bound to the bundled artifacts." });
    }
  });

export type RecordedExtractionBundle = z.infer<typeof RecordedExtractionBundleSchema>;
export type RecordedSemanticFinding = z.infer<typeof RecordedSemanticFindingSchema>;
