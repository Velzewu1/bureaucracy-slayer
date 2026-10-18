import { ProcedureModelSchema } from "../../../src/contracts/index.js";
import { validateEvidence } from "../../../src/evidence/index.js";
import {
  auditSemanticQualifiers,
  deriveObservedGoalScope,
  selectFocusedSources,
} from "../../../src/extractor/index.js";
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
export const LIVE_TEST_CANCELLATION_GOAL =
  "Can I cancel a scheduled Standard transfer before processing starts?";
export const LIVE_DEMO_CANCELLATION_GOAL = "Can I cancel my scheduled bank transfer?";
export const LIVE_TEST_RECOVERY_GOAL =
  "Can I request recovery for a completed transfer?";
export const LIVE_DEMO_MISTAKEN_RECOVERY_GOAL =
  "I completed a transfer to the wrong recipient. How can I request recovery?";
export const NORTHSTAR_A2_COMPLETED_RECOVERY_GOAL =
  "I sent a completed transfer to the wrong recipient. How can I recover it?";
export const LIVE_TEST_RECOVERY_PREREQUISITES_GOAL =
  "What information do I need to submit a recovery request?";
export const LIVE_TEST_UNAUTHORIZED_GOAL =
  "I found a transfer I did not authorize. What should I do?";
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

function deterministicModelForGoal(goal: string) {
  const recorded = RecordedExtractionBundleSchema.parse(recordedSonnetBundleInput);
  const snapshot = recorded.sourceSnapshot;
  const blockCitation = (blockId: string) => {
    for (const page of snapshot.pages) {
      const block = page.blocks.find((candidate) => candidate.id === blockId);
      if (block !== undefined) {
        return {
          pageId: page.id,
          pageUrl: page.url,
          blockId: block.id,
          excerpt: block.text,
          actionIds: [],
        };
      }
    }
    throw new Error(`Missing deterministic fixture block ${blockId}.`);
  };

  if (goal === LIVE_TEST_CANCELLATION_GOAL || goal === LIVE_DEMO_CANCELLATION_GOAL) {
    return ProcedureModelSchema.parse({
      schemaVersion: 1,
      id: "procedure_fixture_cancel_transfer",
      sourceSnapshotId: snapshot.id,
      sourceSnapshotHash: snapshot.contentHash,
      extractedAt: COMPLETED_AT,
      goalSummary: "Determine whether a scheduled Standard transfer can be canceled before processing starts.",
      factDefinitions: [
        {
          key: "transfer_status",
          label: "Transfer status",
          type: "string",
          allowedValues: ["scheduled", "processing", "completed"],
          sensitive: false,
        },
        {
          key: "transfer_type",
          label: "Transfer type",
          type: "string",
          allowedValues: ["standard", "instant"],
          sensitive: false,
        },
        {
          key: "processing_started",
          label: "Transfer processing has begun",
          type: "boolean",
          sensitive: false,
        },
      ],
      actions: [{
        id: "proc_cancel_transfer",
        kind: "interact",
        label: "Cancel transfer",
        description: "Use the observed Cancel transfer control only when every policy condition is satisfied.",
        websiteActionId: "action_cec971f543cc085511e5",
        prerequisiteActionIds: [],
        terminal: true,
      }],
      goalActionIds: ["proc_cancel_transfer"],
      rules: [
        {
          id: "rule_fixture_permit_cancel_standard",
          actionId: "proc_cancel_transfer",
          appliesWhen: {
            kind: "all",
            conditions: [
              { kind: "fact", fact: "transfer_status", op: "eq", value: "scheduled" },
              { kind: "fact", fact: "transfer_type", op: "eq", value: "standard" },
              { kind: "fact", fact: "processing_started", op: "eq", value: false },
            ],
          },
          citations: [blockCitation("block_fc059175893c4915951c")],
          semanticConfidence: 1,
          needsReview: false,
          effect: "permit",
        },
        {
          id: "rule_fixture_prohibit_cancel_instant",
          actionId: "proc_cancel_transfer",
          appliesWhen: { kind: "fact", fact: "transfer_type", op: "eq", value: "instant" },
          citations: [blockCitation("block_0408d3189733d101eb07")],
          semanticConfidence: 1,
          needsReview: false,
          effect: "prohibit",
        },
        {
          id: "rule_fixture_prohibit_cancel_processing",
          actionId: "proc_cancel_transfer",
          appliesWhen: { kind: "fact", fact: "processing_started", op: "eq", value: true },
          citations: [blockCitation("block_c6e0f05342f8d9849468")],
          semanticConfidence: 1,
          needsReview: false,
          effect: "prohibit",
        },
        {
          id: "rule_fixture_prohibit_cancel_completed",
          actionId: "proc_cancel_transfer",
          appliesWhen: { kind: "fact", fact: "transfer_status", op: "eq", value: "completed" },
          citations: [blockCitation("block_d05c4b0d40cf058b55be")],
          semanticConfidence: 1,
          needsReview: false,
          effect: "prohibit",
        },
        {
          id: "rule_fixture_prohibit_cancel_unavailable_status",
          actionId: "proc_cancel_transfer",
          appliesWhen: {
            kind: "any",
            conditions: [
              { kind: "fact", fact: "transfer_status", op: "eq", value: "processing" },
              { kind: "fact", fact: "transfer_status", op: "eq", value: "completed" },
            ],
          },
          citations: [blockCitation("block_7205f3b02098bdd5cda6")],
          semanticConfidence: 1,
          needsReview: false,
          effect: "prohibit",
        },
      ],
    });
  }

  if (goal === LIVE_TEST_UNAUTHORIZED_GOAL) {
    return ProcedureModelSchema.parse({
      schemaVersion: 1,
      id: "procedure_fixture_unauthorized_transfer",
      sourceSnapshotId: snapshot.id,
      sourceSnapshotHash: snapshot.contentHash,
      extractedAt: COMPLETED_AT,
      goalSummary:
        "Identify whether an unrecognized transfer uses the unauthorized report or must not be filed as a mistaken transfer.",
      factDefinitions: [
        {
          key: "initiated_by_user",
          label: "User started the transfer themselves",
          type: "boolean",
          sensitive: false,
        },
        {
          key: "transfer_reference_available",
          label: "Transfer reference number is available",
          type: "boolean",
          sensitive: false,
        },
        {
          key: "transfer_date_available",
          label: "Transfer date is available",
          type: "boolean",
          sensitive: false,
        },
        {
          key: "transfer_amount_available",
          label: "Transfer amount is available",
          type: "boolean",
          sensitive: false,
        },
        {
          key: "first_notice_date_available",
          label: "Date first noticed is available",
          type: "boolean",
          sensitive: false,
        },
        {
          key: "account_secured",
          label: "Account has been secured",
          type: "boolean",
          sensitive: false,
        },
      ],
      actions: [
        {
          id: "proc_submit_unauthorized_report",
          kind: "interact",
          label: "Submit unauthorized transfer report",
          description:
            "Provide the required transfer identification, date first noticed, and account-security answer in the observed unauthorized-transfer form, then submit it. Guidance only; nothing is submitted automatically.",
          websiteActionId: "action_d230d16f5b8ae26d7990",
          prerequisiteActionIds: [],
          terminal: true,
        },
        {
          id: "proc_submit_mistaken_report",
          kind: "interact",
          label: "Submit mistaken transfer report",
          description: "The mistaken-transfer form is a different procedure from an unauthorized report.",
          websiteActionId: "action_1a4c47be86f1e1e46e08",
          prerequisiteActionIds: [],
          terminal: true,
        },
        {
          id: "proc_submit_recovery_request",
          kind: "interact",
          label: "Submit recovery request",
          description: "The recovery form is not the unauthorized-transfer procedure.",
          websiteActionId: "action_fd8698d94a9e2dd25f9e",
          prerequisiteActionIds: [],
          terminal: true,
        },
      ],
      goalActionIds: ["proc_submit_unauthorized_report", "proc_submit_mistaken_report"],
      rules: [
        {
          id: "rule_fixture_permit_unauthorized_report",
          actionId: "proc_submit_unauthorized_report",
          appliesWhen: { kind: "fact", fact: "initiated_by_user", op: "eq", value: false },
          citations: [blockCitation("block_aac34263e3a080f70ed2")],
          semanticConfidence: 1,
          needsReview: false,
          effect: "permit",
        },
        {
          id: "rule_fixture_prohibit_unauthorized_when_self_started",
          actionId: "proc_submit_unauthorized_report",
          appliesWhen: { kind: "fact", fact: "initiated_by_user", op: "eq", value: true },
          citations: [blockCitation("block_6230c45471a8299492f3")],
          semanticConfidence: 1,
          needsReview: false,
          effect: "prohibit",
        },
        {
          id: "rule_fixture_prohibit_mistaken_when_not_started",
          actionId: "proc_submit_mistaken_report",
          appliesWhen: { kind: "fact", fact: "initiated_by_user", op: "eq", value: false },
          citations: [blockCitation("block_e841eb9eb431aa29440b")],
          semanticConfidence: 1,
          needsReview: false,
          effect: "prohibit",
        },
        {
          id: "rule_fixture_permit_mistaken_when_self_started",
          actionId: "proc_submit_mistaken_report",
          appliesWhen: { kind: "fact", fact: "initiated_by_user", op: "eq", value: true },
          citations: [blockCitation("block_6230c45471a8299492f3")],
          semanticConfidence: 1,
          needsReview: false,
          effect: "permit",
        },
        {
          id: "rule_fixture_require_unauthorized_identity",
          actionId: "proc_submit_unauthorized_report",
          appliesWhen: { kind: "always" },
          citations: [blockCitation("block_5b50aae8d3e4fa18f7a6")],
          semanticConfidence: 1,
          needsReview: false,
          effect: "require_condition",
          requirement: {
            kind: "any",
            conditions: [
              {
                kind: "fact",
                fact: "transfer_reference_available",
                op: "eq",
                value: true,
              },
              {
                kind: "all",
                conditions: [
                  {
                    kind: "fact",
                    fact: "transfer_date_available",
                    op: "eq",
                    value: true,
                  },
                  {
                    kind: "fact",
                    fact: "transfer_amount_available",
                    op: "eq",
                    value: true,
                  },
                ],
              },
            ],
          },
        },
        {
          id: "rule_fixture_require_unauthorized_notice_date",
          actionId: "proc_submit_unauthorized_report",
          appliesWhen: { kind: "always" },
          citations: [blockCitation("block_8e2ce14c3ab15f83b3fe")],
          semanticConfidence: 1,
          needsReview: false,
          effect: "require_condition",
          requirement: {
            kind: "fact",
            fact: "first_notice_date_available",
            op: "eq",
            value: true,
          },
        },
        {
          id: "rule_fixture_require_account_security_answer",
          actionId: "proc_submit_unauthorized_report",
          appliesWhen: { kind: "always" },
          citations: [blockCitation("block_4ed17b376dfb6f410a47")],
          semanticConfidence: 1,
          needsReview: false,
          effect: "require_condition",
          requirement: {
            kind: "any",
            conditions: [
              {
                kind: "fact",
                fact: "account_secured",
                op: "eq",
                value: true,
              },
              {
                kind: "fact",
                fact: "account_secured",
                op: "eq",
                value: false,
              },
            ],
          },
        },
        {
          id: "rule_fixture_prohibit_recovery_when_not_started",
          actionId: "proc_submit_recovery_request",
          appliesWhen: { kind: "fact", fact: "initiated_by_user", op: "eq", value: false },
          citations: [blockCitation("block_e841eb9eb431aa29440b")],
          semanticConfidence: 1,
          needsReview: false,
          effect: "prohibit",
        },
      ],
    });
  }

  if (
    goal === LIVE_TEST_RECOVERY_GOAL ||
    goal === LIVE_TEST_RECOVERY_PREREQUISITES_GOAL ||
    goal === LIVE_DEMO_MISTAKEN_RECOVERY_GOAL ||
    goal === NORTHSTAR_A2_COMPLETED_RECOVERY_GOAL
  ) {
    const keepActions = new Set([
      "proc_cancel_transfer",
      "proc_open_support",
      "proc_provide_reference_and_recipient",
      "proc_provide_description_and_email",
      "proc_submit_recovery_request",
    ]);
    const keepRules = new Set([
      "rule_r1_prohibit_cancel_completed",
      "rule_r4_permit_recovery_completed_self_initiated",
      "rule_r5_prohibit_recovery_not_initiated",
      "rule_r6_require_recovery_reference_and_recipient",
      "rule_r7_require_recovery_description_and_email",
      "rule_r8_require_instant_completed_before_recovery",
    ]);
    const model = structuredClone(recorded.procedureModel);
    return ProcedureModelSchema.parse({
      ...model,
      id:
        goal === LIVE_TEST_RECOVERY_PREREQUISITES_GOAL
          ? "procedure_fixture_recovery_requirements"
          : "procedure_fixture_completed_recovery",
      goalSummary:
        goal === LIVE_TEST_RECOVERY_PREREQUISITES_GOAL
          ? "Identify the information and steps required to submit a completed-transfer recovery request."
          : "Determine eligibility and the grounded steps for requesting recovery of a completed transfer.",
      actions: model.actions.filter((action) => keepActions.has(action.id)),
      goalActionIds: ["proc_cancel_transfer", "proc_submit_recovery_request"],
      rules: model.rules
        .filter((rule) => keepRules.has(rule.id))
        .map((rule) =>
          rule.id === "rule_r4_permit_recovery_completed_self_initiated"
            ? {
                ...rule,
                needsReview: false,
                reviewReason: undefined,
                citations: [
                  blockCitation("block_4b3e165045ebe5b2a429"),
                  blockCitation("block_ef8db3de371a0edb6f58"),
                ],
              }
            : rule,
        ),
    });
  }

  return undefined;
}

/** Explicit hand-authored offline fixture; never represented as a Sonnet response. */
export function createGoalSpecificLiveArtifactFixture(
  goal: string,
): LiveExtractionArtifact | undefined {
  const recorded = RecordedExtractionBundleSchema.parse(recordedSonnetBundleInput);
  const snapshot = recorded.sourceSnapshot;
  const model = deterministicModelForGoal(goal);
  if (model === undefined) return undefined;
  const scope = deriveObservedGoalScope(snapshot, goal);
  if (scope === undefined) return undefined;
  const selection = selectFocusedSources(
    snapshot,
    goal,
    { maxPages: 9, maxBlocks: 80, maxActions: 35 },
    scope,
  );
  if (selection.coverage !== "complete") return undefined;
  const semanticAudit = auditSemanticQualifiers(snapshot, model);
  const validation = validateEvidence(
    snapshot,
    model,
    {
      evidenceResultId: `evidence_fixture_${model.id}`,
      checkedAt: COMPLETED_AT,
    },
    semanticAudit.findings.map((finding) => ({
      ruleId: finding.ruleId,
      message: finding.message,
    })),
  );
  if (!validation.ok) {
    throw new Error(`Goal-specific fixture failed evidence validation: ${validation.issues.join("; ")}`);
  }
  return LiveExtractionArtifactSchema.parse({
    schemaVersion: 1,
    artifactKind: "live_sonnet_extraction",
    goal,
    portalUrl: LIVE_TEST_PORTAL_URL,
    sourceSnapshot: snapshot,
    procedureModel: validation.model,
    evidence: validation.evidence,
    sourceSelection: {
      sourceSnapshotId: selection.sourceSnapshotId,
      sourceSnapshotHash: selection.sourceSnapshotHash,
      userGoal: goal,
      selectionMode: "goal_scoped",
      semanticCoverage: "not_verified",
      coverage: "complete",
      limitations: [],
      originalCounts: selection.originalCounts,
      selectedCounts: selection.selectedCounts,
      selectedPageIds: selection.pages.map((page) => page.pageId),
    },
    semanticAudit,
    provenance: {
      extractionType: "live",
      modelName: "deterministic-offline-test-fixture",
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

export function createLiveStartResponseFixture(
  jobId: string = LIVE_TEST_JOB_ID,
): LiveExtractionStartResponse {
  return LiveExtractionStartResponseSchema.parse({
    schemaVersion: 1,
    jobId,
    state: "queued",
    statusUrl: `${LIVE_EXTRACTION_START_ROUTE}/${jobId}`,
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
    "UNSUPPORTED_MEDIA_TYPE" | "REQUEST_IDENTITY_MISMATCH" | "JOB_ALREADY_RUNNING" |
    "JOB_NOT_FOUND" | "JOB_EXPIRED",
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
