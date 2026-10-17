import { validateEvidence } from "../../../src/evidence/index.js";
import { auditSemanticQualifiers } from "../../../src/extractor/index.js";
import {
  LIVE_EXTRACTION_POLL_INTERVAL_MS,
  LIVE_EXTRACTION_START_ROUTE,
  LiveExtractionArtifactSchema,
  LiveExtractionErrorResponseSchema,
  LiveExtractionJobStatusSchema,
  LiveExtractionStartRequestSchema,
  LiveExtractionStartResponseSchema,
  type LiveExtractionArtifact,
  type LiveExtractionErrorResponse,
  type LiveExtractionJobStatus,
  type LiveExtractionStartRequest,
  type LiveExtractionStartResponse,
} from "../../../src/orchestration/live-extraction-contract.js";
import { recordedSonnetBundleInput } from "../../../src/ui/generated/recordedSonnetBundle.js";
import { RecordedExtractionBundleSchema } from "../../../src/ui/recordedBundle.js";

export const LIVE_TEST_GOAL =
  "I sent an $850 transfer to the wrong recipient. Can I cancel it? If not, what are my alternatives?";
export const LIVE_TEST_PORTAL_URL = "http://127.0.0.1:5180/dashboard";
export const LIVE_TEST_JOB_ID = "job_1234567890abcdef1234567890abcdef";
export const LIVE_TEST_REQUEST_ID = "request_1234567890abcdef1234567890abcdef";

const CREATED_AT = "2026-10-17T11:58:00.000Z";
const STARTED_AT = "2026-10-17T11:58:01.000Z";
const COMPLETED_AT = "2026-10-17T12:00:00.000Z";
const EXPIRES_AT = "2026-10-17T12:15:00.000Z";

export function createLiveArtifactFixture(): LiveExtractionArtifact {
  const recorded = RecordedExtractionBundleSchema.parse(recordedSonnetBundleInput);
  const snapshot = recorded.sourceSnapshot;
  const model = recorded.procedureModel;
  const semanticAudit = auditSemanticQualifiers(snapshot, model);
  const validation = validateEvidence(
    snapshot,
    model,
    {
      evidenceResultId: recorded.buildTimeEvidence.id,
      checkedAt: recorded.buildTimeEvidence.checkedAt,
    },
    semanticAudit.findings.map((finding) => ({
      ruleId: finding.ruleId,
      message: finding.message,
    })),
  );
  if (!validation.ok) {
    throw new Error(`Live contract fixture failed evidence validation: ${validation.issues.join("; ")}`);
  }
  return LiveExtractionArtifactSchema.parse({
    schemaVersion: 1,
    artifactKind: "live_sonnet_extraction",
    goal: LIVE_TEST_GOAL,
    portalUrl: LIVE_TEST_PORTAL_URL,
    sourceSnapshot: snapshot,
    procedureModel: validation.model,
    evidence: validation.evidence,
    sourceSelection: {
      sourceSnapshotId: snapshot.id,
      sourceSnapshotHash: snapshot.contentHash,
      userGoal: LIVE_TEST_GOAL,
      selectionMode: "goal_scoped",
      semanticCoverage: "not_verified",
      coverage: "complete",
      limitations: [],
      originalCounts: recorded.sourceSelection.originalCounts,
      selectedCounts: recorded.sourceSelection.selectedCounts,
      selectedPageIds: recorded.sourceSelection.selectedPageIds,
    },
    semanticAudit,
    provenance: {
      extractionType: "live",
      modelName: "claude-sonnet-test",
      completedAt: COMPLETED_AT,
    },
  });
}

export function createLiveStartRequestFixture(
  requestId = LIVE_TEST_REQUEST_ID,
): LiveExtractionStartRequest {
  return LiveExtractionStartRequestSchema.parse({
    schemaVersion: 1,
    action: "start_live_extraction",
    requestId,
  });
}

export function createLiveStartResponseFixture(): LiveExtractionStartResponse {
  return LiveExtractionStartResponseSchema.parse({
    schemaVersion: 1,
    jobId: LIVE_TEST_JOB_ID,
    state: "queued",
    statusUrl: `${LIVE_EXTRACTION_START_ROUTE}/${LIVE_TEST_JOB_ID}`,
    pollAfterMs: LIVE_EXTRACTION_POLL_INTERVAL_MS,
  });
}

export function createLiveJobTimelineFixture(): readonly LiveExtractionJobStatus[] {
  const base = {
    schemaVersion: 1,
    jobId: LIVE_TEST_JOB_ID,
    requestId: LIVE_TEST_REQUEST_ID,
    createdAt: CREATED_AT,
  } as const;
  return [
    LiveExtractionJobStatusSchema.parse({
      ...base,
      state: "queued",
      phase: "queued",
      updatedAt: CREATED_AT,
    }),
    LiveExtractionJobStatusSchema.parse({
      ...base,
      state: "running",
      phase: "collecting",
      updatedAt: "2026-10-17T11:58:05.000Z",
      startedAt: STARTED_AT,
    }),
    LiveExtractionJobStatusSchema.parse({
      ...base,
      state: "running",
      phase: "selecting_sources",
      updatedAt: "2026-10-17T11:58:15.000Z",
      startedAt: STARTED_AT,
    }),
    LiveExtractionJobStatusSchema.parse({
      ...base,
      state: "running",
      phase: "extracting_policy",
      updatedAt: "2026-10-17T11:58:30.000Z",
      startedAt: STARTED_AT,
    }),
    LiveExtractionJobStatusSchema.parse({
      ...base,
      state: "running",
      phase: "mapping_procedure",
      updatedAt: "2026-10-17T11:59:00.000Z",
      startedAt: STARTED_AT,
    }),
    LiveExtractionJobStatusSchema.parse({
      ...base,
      state: "running",
      phase: "validating",
      updatedAt: "2026-10-17T11:59:30.000Z",
      startedAt: STARTED_AT,
    }),
    LiveExtractionJobStatusSchema.parse({
      ...base,
      state: "succeeded",
      phase: "complete",
      updatedAt: COMPLETED_AT,
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
      expiresAt: EXPIRES_AT,
      result: createLiveArtifactFixture(),
    }),
  ];
}

export function createLiveFailedStatusFixture(): LiveExtractionJobStatus {
  return LiveExtractionJobStatusSchema.parse({
    schemaVersion: 1,
    jobId: LIVE_TEST_JOB_ID,
    requestId: LIVE_TEST_REQUEST_ID,
    state: "failed",
    phase: "failed",
    createdAt: CREATED_AT,
    updatedAt: COMPLETED_AT,
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    expiresAt: EXPIRES_AT,
    error: {
      code: "STAGE_2_TRANSPORT_FAILED",
      stage: "procedure_mapping",
      message: "Procedure mapping could not be reached.",
      retryable: true,
      issueCodes: [],
    },
  });
}

export function createTamperedLiveStatusFixture(): unknown {
  const status = createLiveJobTimelineFixture().at(-1);
  if (status?.state !== "succeeded") throw new Error("Expected a succeeded live fixture.");
  return {
    ...status,
    result: {
      ...status.result,
      evidence: {
        ...status.result.evidence,
        procedureModelId: "procedure_tampered1",
      },
    },
  };
}

export function createLiveErrorResponseFixture(
  code: "REQUEST_INVALID" | "REQUEST_TOO_LARGE" | "UNSUPPORTED_ACTION" |
    "UNSUPPORTED_MEDIA_TYPE" | "JOB_ALREADY_RUNNING" | "JOB_NOT_FOUND" | "JOB_EXPIRED",
): LiveExtractionErrorResponse {
  const stage = code.startsWith("JOB_") ? "job" : "request";
  return LiveExtractionErrorResponseSchema.parse({
    schemaVersion: 1,
    error: {
      code,
      stage,
      message: "The live extraction request could not be completed.",
      retryable: false,
      issueCodes: [],
    },
  });
}
