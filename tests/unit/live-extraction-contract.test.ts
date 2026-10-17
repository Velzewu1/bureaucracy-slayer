import { describe, expect, it } from "vitest";

import { ProcedureModelSchema, SiteSnapshotSchema } from "../../src/contracts/index.js";
import { validateEvidence } from "../../src/evidence/index.js";
import { auditSemanticQualifiers } from "../../src/extractor/index.js";
import {
  LIVE_EXTRACTION_POLL_INTERVAL_MS,
  LiveExtractionArtifactSchema,
  LiveExtractionJobStatusSchema,
  LiveExtractionStartRequestSchema,
  LiveExtractionStartResponseSchema,
} from "../../src/orchestration/live-extraction-contract.js";
import {
  baseProcedureModelFixture,
  baseSnapshotFixture,
  evidenceContextFixture,
} from "../fixtures/p0.js";

const LIVE_EXTRACTION_GOAL =
  "I sent an $850 transfer to the wrong recipient. Can I cancel it? If not, what are my alternatives?";
const LIVE_EXTRACTION_PORTAL_URL = "http://127.0.0.1:5180/dashboard";

function liveArtifact() {
  const snapshot = SiteSnapshotSchema.parse({
    ...baseSnapshotFixture,
    rootUrl: LIVE_EXTRACTION_PORTAL_URL,
  });
  const model = ProcedureModelSchema.parse(baseProcedureModelFixture);
  const audit = auditSemanticQualifiers(snapshot, model);
  const validation = validateEvidence(
    snapshot,
    model,
    evidenceContextFixture,
    audit.findings.map((finding) => ({ ruleId: finding.ruleId, message: finding.message })),
  );
  if (!validation.ok) throw new Error("Test fixture did not pass canonical evidence validation.");
  const sourceCounts = {
    pages: snapshot.pages.length,
    blocks: snapshot.pages.reduce((count, page) => count + page.blocks.length, 0),
    actions: snapshot.pages.reduce((count, page) => count + page.actions.length, 0),
  };

  return {
    schemaVersion: 1,
    artifactKind: "live_sonnet_extraction",
    goal: LIVE_EXTRACTION_GOAL,
    portalUrl: LIVE_EXTRACTION_PORTAL_URL,
    sourceSnapshot: snapshot,
    procedureModel: validation.model,
    evidence: validation.evidence,
    sourceSelection: {
      sourceSnapshotId: snapshot.id,
      sourceSnapshotHash: snapshot.contentHash,
      userGoal: LIVE_EXTRACTION_GOAL,
      selectionMode: "goal_scoped",
      semanticCoverage: "not_verified",
      coverage: "complete",
      limitations: [],
      originalCounts: sourceCounts,
      selectedCounts: sourceCounts,
      selectedPageIds: snapshot.pages.map((page) => page.id),
    },
    semanticAudit: audit,
    provenance: {
      extractionType: "live",
      modelName: "claude-sonnet-test",
      completedAt: "2026-10-17T12:00:00.000Z",
    },
  } as const;
}

describe("live extraction API contract", () => {
  it("accepts only the fixed, idempotent start command", () => {
    expect(
      LiveExtractionStartRequestSchema.parse({
        schemaVersion: 1,
        action: "start_live_extraction",
        requestId: "request_1234567890abcdef1234567890abcdef",
      }),
    ).toEqual({
      schemaVersion: 1,
      action: "start_live_extraction",
      requestId: "request_1234567890abcdef1234567890abcdef",
    });

    expect(
      LiveExtractionStartRequestSchema.safeParse({
        schemaVersion: 1,
        action: "start_live_extraction",
        requestId: "request_1234567890abcdef1234567890abcdef",
        portalUrl: "https://attacker.example/",
      }).success,
    ).toBe(false);
    expect(
      LiveExtractionStartRequestSchema.safeParse({
        schemaVersion: 1,
        action: "extract_arbitrary_goal",
        requestId: "request_1234567890abcdef1234567890abcdef",
      }).success,
    ).toBe(false);
  });

  it("binds the accepted status URL to its job id", () => {
    expect(
      LiveExtractionStartResponseSchema.safeParse({
        schemaVersion: 1,
        jobId: "job_1234567890abcdef1234567890abcdef",
        state: "queued",
        statusUrl: "/api/live-extraction/jobs/job_abcdefabcdefabcdefabcdefabcdefab",
        pollAfterMs: LIVE_EXTRACTION_POLL_INTERVAL_MS,
      }).success,
    ).toBe(false);
  });

  it("accepts a successful job containing canonical trust artifacts", () => {
    const artifact = LiveExtractionArtifactSchema.parse(liveArtifact());
    const status = LiveExtractionJobStatusSchema.parse({
      schemaVersion: 1,
      jobId: "job_1234567890abcdef1234567890abcdef",
      requestId: "request_1234567890abcdef1234567890abcdef",
      state: "succeeded",
      phase: "complete",
      createdAt: "2026-10-17T11:58:00.000Z",
      updatedAt: "2026-10-17T12:00:00.000Z",
      startedAt: "2026-10-17T11:58:01.000Z",
      completedAt: "2026-10-17T12:00:00.000Z",
      expiresAt: "2026-10-17T12:15:00.000Z",
      result: artifact,
    });

    expect(status.state).toBe("succeeded");
    if (status.state === "succeeded") {
      expect(status.result.evidence.status).toBe("degraded");
    }
  });

  it("rejects artifact identity drift and unsupported server claims", () => {
    const artifact = liveArtifact();
    expect(
      LiveExtractionArtifactSchema.safeParse({
        ...artifact,
        evidence: { ...artifact.evidence, procedureModelId: "model_different1" },
      }).success,
    ).toBe(false);
    expect(
      LiveExtractionArtifactSchema.safeParse({
        ...artifact,
        verified: true,
      }).success,
    ).toBe(false);
  });

  it("keeps operational failures separate from successful review artifacts", () => {
    expect(
      LiveExtractionJobStatusSchema.safeParse({
        schemaVersion: 1,
        jobId: "job_1234567890abcdef1234567890abcdef",
        requestId: "request_1234567890abcdef1234567890abcdef",
        state: "failed",
        phase: "failed",
        createdAt: "2026-10-17T11:58:00.000Z",
        updatedAt: "2026-10-17T11:59:00.000Z",
        startedAt: "2026-10-17T11:58:01.000Z",
        completedAt: "2026-10-17T11:59:00.000Z",
        expiresAt: "2026-10-17T12:14:00.000Z",
        error: {
          code: "STAGE_2_RESPONSE_INVALID",
          stage: "procedure_mapping",
          message: "Procedure mapping returned an invalid structured response.",
          retryable: false,
          issueCodes: [],
        },
        result: liveArtifact(),
      }).success,
    ).toBe(false);
  });
});
