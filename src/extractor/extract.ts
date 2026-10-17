import { z } from "zod";

import {
  IdSchema,
  IsoDateTimeSchema,
  SiteSnapshotSchema,
  type SiteSnapshot,
} from "../contracts/index.js";
import type { EvidenceValidationContext } from "../evidence/index.js";
import { validateEvidence } from "../evidence/index.js";
import { ClaudeTransportError } from "./anthropic.js";
import {
  buildPolicyExtractionRequest,
  buildProcedureMappingRequest,
} from "./prompt.js";
import { parseClaudeStructuredResponse } from "./response.js";
import {
  selectFocusedSources,
  GoalScopedExtractionSchema,
  SourceSelectionBudgetSchema,
  validateFocusedSourceCatalogBindings,
  type FocusedSourceCatalog,
} from "./source-selection.js";

import {
  analyzePolicyExtraction,
  convertStagedExtraction,
  validateProcedureMapping,
  type PolicyExtractionDTO,
} from "./staged.js";

import { auditSemanticQualifiers } from "./semantic-audit.js";
import type {
  ClaudeMessageRequest,
  ExtractProcedureOptions,
  ExtractionDebugEvent,
  ExtractionFailure,
  ExtractionOutcome,
  ResumedExtractionOutcome,
  ResumeProcedureMappingOptions,
} from "./types.js";

const UserGoalSchema = z.string().trim().min(1).max(2_000);
const ModelNameSchema = z.string().trim().min(1).max(200);
const MaxTokensSchema = z.number().int().min(256).max(128_000);
const EvidenceContextSchema = z
  .object({
    evidenceResultId: IdSchema,
    checkedAt: IsoDateTimeSchema,
  })
  .strict();

type ModelStage = "policy_extraction" | "procedure_mapping";

function zodIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);
}

function failure(
  code: ExtractionFailure["code"],
  stage: ExtractionFailure["stage"],
  message: string,
  issues: readonly string[],
  attempts: number,
  modelStage?: ModelStage,
): ExtractionFailure {
  return { ok: false, code, stage, message, issues, attempts, ...(modelStage === undefined ? {} : { modelStage }) };
}

function configuredModel(options: ExtractProcedureOptions): string | undefined {
  const environment = options.environment ?? process.env;
  return options.model?.trim() || environment["ANTHROPIC_MODEL"]?.trim();
}

function emitDebugEvent(options: ExtractProcedureOptions, event: ExtractionDebugEvent): void {
  options.onDebugEvent?.(event);
}

function emitStageFailure(
  options: ExtractProcedureOptions,
  stage: ModelStage,
  issues: readonly string[],
): void {
  emitDebugEvent(options, { kind: "stage_outcome", stage, status: "failed", issues });
}

async function runProcedureMapping(
  snapshot: SiteSnapshot,
  catalog: FocusedSourceCatalog,
  policy: PolicyExtractionDTO,
  model: string,
  maxTokens: number,
  evidenceContext: EvidenceValidationContext,
  options: ExtractProcedureOptions,
  previousAttempts: number,
): Promise<ExtractionOutcome> {
  const mappingRequest = buildProcedureMappingRequest(catalog, policy, model, maxTokens);
  const mappingTransport = await callTransport(
    mappingRequest,
    options,
    "procedure_mapping",
    previousAttempts,
  );
  if (!mappingTransport.ok) {
    emitStageFailure(options, "procedure_mapping", mappingTransport.issues);
    return mappingTransport;
  }
  const mappingResponse = parseClaudeStructuredResponse(mappingTransport.response, maxTokens);
  emitDebugEvent(options, {
    kind: "claude_response_metadata",
    stage: "procedure_mapping",
    metadata: mappingResponse.metadata,
  });
  if (!mappingResponse.ok) {
    emitStageFailure(options, "procedure_mapping", mappingResponse.issues);
    return failure(
      "CLAUDE_RESPONSE_INVALID",
      "response",
      "Claude Stage 2 did not return one complete structured JSON response.",
      mappingResponse.issues,
      mappingTransport.attempts,
      "procedure_mapping",
    );
  }
  emitDebugEvent(options, {
    kind: "procedure_mapping_dto",
    procedureMappingDto: mappingResponse.value,
  });
  const mapping = validateProcedureMapping(mappingResponse.value, policy, catalog);
  if (!mapping.ok) {
    emitStageFailure(options, "procedure_mapping", mapping.issues);
    return failure(
      "PROCEDURE_MAPPING_INVALID",
      "procedure_mapping",
      "Claude Stage 2 procedure mapping failed deterministic validation.",
      mapping.issues,
      mappingTransport.attempts,
      "procedure_mapping",
    );
  }
  emitDebugEvent(options, {
    kind: "stage_outcome",
    stage: "procedure_mapping",
    status: "valid",
    issues: [],
  });

  const procedureResult = convertStagedExtraction(policy, mapping.value, snapshot, catalog);
  if (procedureResult.compactDto !== undefined) {
    emitDebugEvent(options, { kind: "compact_dto", compactDto: procedureResult.compactDto });
  }
  if (procedureResult.normalizations.length > 0) {
    emitDebugEvent(options, {
      kind: "conversion_normalization",
      normalizations: procedureResult.normalizations,
    });
  }
  if (!procedureResult.ok) {
    emitDebugEvent(options, {
      kind: "conversion_failure",
      conversionStage:
        procedureResult.stage === "policy" || procedureResult.stage === "mapping"
          ? "conversion"
          : procedureResult.stage,
      issues: procedureResult.issues,
    });
    emitDebugEvent(options, {
      kind: "stage_outcome",
      stage: "canonical_schema",
      status: "failed",
      issues: procedureResult.issues,
    });
    return failure(
      "PROCEDURE_SCHEMA_INVALID",
      "procedure_schema",
      "Validated stage outputs could not be converted to the canonical ProcedureModel schema.",
      procedureResult.issues,
      mappingTransport.attempts,
    );
  }
  emitDebugEvent(options, {
    kind: "stage_outcome",
    stage: "canonical_schema",
    status: "valid",
    issues: [],
  });
  emitDebugEvent(options, {
    kind: "canonical_model",
    procedureModelId: procedureResult.model.id,
    procedureActions: procedureResult.model.actions.map((action) => ({
      id: action.id,
      kind: action.kind,
      ...(action.websiteActionId === undefined ? {} : { websiteActionId: action.websiteActionId }),
    })),
    ruleIds: procedureResult.model.rules.map((rule) => rule.id),
  });

  const semanticAudit = auditSemanticQualifiers(snapshot, procedureResult.model);

  const validation = validateEvidence(
    snapshot,
    procedureResult.model,
    evidenceContext,
    semanticAudit.findings,
  );

  if (!validation.ok) {
    emitDebugEvent(options, { kind: "evidence_validation_failure", issues: validation.issues });
    return failure(
      "EVIDENCE_VALIDATION_FAILED",
      "evidence",
      "The parsed artifacts could not be processed by the evidence validator.",
      validation.issues,
      mappingTransport.attempts,
    );
  }

  emitDebugEvent(options, { kind: "evidence_validation", evidence: validation.evidence });
  return {
    ok: true,
    status: validation.evidence.status === "valid" ? "evidence_valid" : "review_required",
    model: validation.model,
    evidence: validation.evidence,
    attempts: mappingTransport.attempts,
    sourceSelection: catalog,
  };
}

function transportFailureIssues(error: unknown, retryExhausted: boolean): readonly string[] {
  if (!(error instanceof ClaudeTransportError)) {
    return ["The transport rejected with an unrecognized error; no unsafe details were exposed."];
  }

  const diagnostic = error.diagnostic;
  return [
    ...(retryExhausted ? ["A transient Claude request failure exhausted the configured retry limit."] : []),
    `Error class: ${diagnostic.errorClass}`,
    ...(diagnostic.httpStatus === null ? [] : [`HTTP status: ${diagnostic.httpStatus}`]),
    ...(diagnostic.anthropicErrorType === null
      ? []
      : [`Anthropic error type: ${diagnostic.anthropicErrorType}`]),
    ...(diagnostic.anthropicErrorCode === null
      ? []
      : [`Anthropic error code: ${diagnostic.anthropicErrorCode}`]),
    ...(diagnostic.requestId === null ? [] : [`Request ID: ${diagnostic.requestId}`]),
    `Message: ${diagnostic.message}`,
    `Potentially retryable: ${diagnostic.potentiallyRetryable ? "yes" : "no"}`,
  ];
}

async function callTransport(
  request: ClaudeMessageRequest,
  options: ExtractProcedureOptions,
  modelStage: ModelStage,
  previousAttempts: number,
): Promise<Readonly<{ ok: true; response: unknown; attempts: number }> | ExtractionFailure> {
  const maxAttempts = 1 + (options.maxTransientRetries ?? 0);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return {
        ok: true,
        response: await options.transport.createMessage(request),
        attempts: previousAttempts + attempt,
      };
    } catch (error) {
      const retryable = error instanceof ClaudeTransportError && error.retryable;
      if (!retryable || attempt === maxAttempts) {
        return failure(
          "CLAUDE_REQUEST_FAILED",
          "transport",
          `Claude ${modelStage === "policy_extraction" ? "policy extraction" : "procedure mapping"} was unavailable; no ProcedureModel was produced.`,
          transportFailureIssues(error, retryable && attempt === maxAttempts),
          previousAttempts + attempt,
          modelStage,
        );
      }
    }
  }
  return failure(
    "CLAUDE_REQUEST_FAILED",
    "transport",
    "Claude extraction failed.",
    [],
    previousAttempts + maxAttempts,
    modelStage,
  );
}

/**
 * Probabilistic interpretation boundary: focused source selection, two bounded
 * Claude stages, deterministic conversion, and existing evidence validation.
 * This function never evaluates policy, plans a route, or authorizes an action.
 */
export async function extractProcedure(
  snapshotInput: unknown,
  userGoalInput: unknown,
  options: ExtractProcedureOptions,
): Promise<ExtractionOutcome> {
  const snapshotResult = SiteSnapshotSchema.safeParse(snapshotInput);
  const goalResult = UserGoalSchema.safeParse(userGoalInput);
  if (!snapshotResult.success || !goalResult.success) {
    const issues = [
      ...(snapshotResult.success ? [] : zodIssues(snapshotResult.error)),
      ...(goalResult.success ? [] : zodIssues(goalResult.error)),
    ];
    return failure("INPUT_INVALID", "input", "Extraction input did not pass validation.", issues, 0);
  }

  const modelResult = ModelNameSchema.safeParse(configuredModel(options));
  const tokensResult = MaxTokensSchema.safeParse(options.maxTokens ?? 8_192);
  const evidenceContextResult = EvidenceContextSchema.safeParse(options.evidenceContext);
  const budgetResult = SourceSelectionBudgetSchema.safeParse(options.sourceSelectionBudget ?? {});
  const goalScopeResult = GoalScopedExtractionSchema.optional().safeParse(options.goalScope);
  if (
    !modelResult.success ||
    !tokensResult.success ||
    !evidenceContextResult.success ||
    !budgetResult.success ||
    !goalScopeResult.success
  ) {
    const issues = [
      ...(modelResult.success ? [] : zodIssues(modelResult.error)),
      ...(tokensResult.success ? [] : zodIssues(tokensResult.error)),
      ...(evidenceContextResult.success ? [] : zodIssues(evidenceContextResult.error)),
      ...(budgetResult.success ? [] : zodIssues(budgetResult.error)),
      ...(goalScopeResult.success ? [] : zodIssues(goalScopeResult.error)),
    ];
    return failure(
      "CONFIGURATION_INVALID",
      "configuration",
      "A Claude model name, token bound, evidence context, source budget, and valid optional goal scope are required.",
      issues,
      0,
    );
  }

  const snapshot = snapshotResult.data;
  const catalog = selectFocusedSources(
    snapshot,
    goalResult.data,
    budgetResult.data,
    goalScopeResult.data,
  );
  emitDebugEvent(options, { kind: "source_selection", selection: catalog });
  emitDebugEvent(options, {
    kind: "snapshot_reference_catalog",
    pages: snapshot.pages.map((page) => ({
      pageId: page.id,
      blockIds: page.blocks.map((block) => block.id),
      websiteActionIds: page.actions.map((action) => action.id),
    })),
  });
  if (catalog.coverage === "incomplete") {
    return failure(
      "SOURCE_COVERAGE_INCOMPLETE",
      "source_selection",
      "Required goal-focused sources did not fit the configured budget; no Claude request was made.",
      catalog.limitations,
      0,
    );
  }

  const policyRequest = buildPolicyExtractionRequest(
    catalog,
    modelResult.data,
    tokensResult.data,
  );
  const policyTransport = await callTransport(policyRequest, options, "policy_extraction", 0);
  if (!policyTransport.ok) {
    emitStageFailure(options, "policy_extraction", policyTransport.issues);
    return policyTransport;
  }
  const policyResponse = parseClaudeStructuredResponse(policyTransport.response, tokensResult.data);
  emitDebugEvent(options, {
    kind: "claude_response_metadata",
    stage: "policy_extraction",
    metadata: policyResponse.metadata,
  });
  if (!policyResponse.ok) {
    emitStageFailure(options, "policy_extraction", policyResponse.issues);
    return failure(
      "CLAUDE_RESPONSE_INVALID",
      "response",
      "Claude Stage 1 did not return one complete structured JSON response.",
      policyResponse.issues,
      policyTransport.attempts,
      "policy_extraction",
    );
  }
  emitDebugEvent(options, { kind: "policy_dto", policyDto: policyResponse.value });
  const policy = analyzePolicyExtraction(policyResponse.value, catalog);
  if (policy.normalizations.length > 0) {
    emitDebugEvent(options, {
      kind: "policy_normalization",
      normalizations: policy.normalizations,
    });
  }
  if (!policy.ok) {
    emitStageFailure(options, "policy_extraction", policy.issues);
    return failure(
      "POLICY_EXTRACTION_INVALID",
      "policy_extraction",
      "Claude Stage 1 policy output failed deterministic validation.",
      policy.issues,
      policyTransport.attempts,
      "policy_extraction",
    );
  }
  emitDebugEvent(options, {
    kind: "stage_outcome",
    stage: "policy_extraction",
    status: "valid",
    issues: [],
  });

  return runProcedureMapping(
    snapshot,
    catalog,
    policy.value,
    modelResult.data,
    tokensResult.data,
    evidenceContextResult.data,
    options,
    policyTransport.attempts,
  );
}

/**
 * Resumes only Stage 2 from externally saved Stage 1 inputs. Every saved
 * binding and the complete Stage 1 DTO are revalidated before transport use.
 */
export async function resumeProcedureMapping(
  snapshotInput: unknown,
  catalogInput: unknown,
  policyInput: unknown,
  options: ResumeProcedureMappingOptions,
): Promise<ResumedExtractionOutcome> {
  const runtimeOptions: ExtractProcedureOptions = options;
  const snapshotResult = SiteSnapshotSchema.safeParse(snapshotInput);
  if (!snapshotResult.success) {
    return failure(
      "INPUT_INVALID",
      "input",
      "The saved SiteSnapshot did not pass canonical validation.",
      zodIssues(snapshotResult.error),
      0,
    );
  }

  const modelResult = ModelNameSchema.safeParse(configuredModel(runtimeOptions));
  const tokensResult = MaxTokensSchema.safeParse(options.maxTokens ?? 8_192);
  const evidenceContextResult = EvidenceContextSchema.safeParse(options.evidenceContext);
  const artifactLabelResult = z.string().trim().min(1).max(500).optional().safeParse(
    options.sourceArtifactLabel,
  );
  if (
    !modelResult.success ||
    !tokensResult.success ||
    !evidenceContextResult.success ||
    !artifactLabelResult.success
  ) {
    const issues = [
      ...(modelResult.success ? [] : zodIssues(modelResult.error)),
      ...(tokensResult.success ? [] : zodIssues(tokensResult.error)),
      ...(evidenceContextResult.success ? [] : zodIssues(evidenceContextResult.error)),
      ...(artifactLabelResult.success ? [] : zodIssues(artifactLabelResult.error)),
    ];
    return failure(
      "CONFIGURATION_INVALID",
      "configuration",
      "A Claude model name, token bound, evidence context, and optional artifact label are required.",
      issues,
      0,
    );
  }

  const snapshot = snapshotResult.data;
  const catalogResult = validateFocusedSourceCatalogBindings(snapshot, catalogInput);
  if (!catalogResult.ok) {
    return failure(
      "INPUT_INVALID",
      "source_selection",
      "The saved focused-source catalog is not exactly bound to the saved SiteSnapshot.",
      catalogResult.issues,
      0,
    );
  }
  const catalog = catalogResult.value;
  emitDebugEvent(runtimeOptions, { kind: "source_selection", selection: catalog });
  emitDebugEvent(runtimeOptions, {
    kind: "snapshot_reference_catalog",
    pages: snapshot.pages.map((page) => ({
      pageId: page.id,
      blockIds: page.blocks.map((block) => block.id),
      websiteActionIds: page.actions.map((action) => action.id),
    })),
  });
  emitDebugEvent(runtimeOptions, { kind: "policy_dto", policyDto: policyInput });

  const policy = analyzePolicyExtraction(policyInput, catalog);
  if (policy.normalizations.length > 0) {
    emitDebugEvent(runtimeOptions, {
      kind: "policy_normalization",
      normalizations: policy.normalizations,
    });
  }
  if (!policy.ok || policy.normalizations.length > 0) {
    const issues = policy.ok
      ? ["Saved Stage 1 requires deterministic normalization and cannot be resumed unchanged."]
      : policy.issues;
    emitStageFailure(runtimeOptions, "policy_extraction", issues);
    return failure(
      "POLICY_EXTRACTION_INVALID",
      "policy_extraction",
      "The saved Stage 1 policy output failed deterministic replay validation.",
      issues,
      0,
      "policy_extraction",
    );
  }
  emitDebugEvent(runtimeOptions, {
    kind: "stage_outcome",
    stage: "policy_extraction",
    status: "valid",
    issues: [],
  });

  const outcome = await runProcedureMapping(
    snapshot,
    catalog,
    policy.value,
    modelResult.data,
    tokensResult.data,
    evidenceContextResult.data,
    runtimeOptions,
    0,
  );
  if (!outcome.ok) return outcome;
  return {
    ...outcome,
    provenance: {
      stage1Source: "saved_artifact",
      policyAnalysisId: policy.value.policyAnalysisId,
      sourceSnapshotId: snapshot.id,
      sourceSnapshotHash: snapshot.contentHash,
      ...(artifactLabelResult.data === undefined
        ? {}
        : { sourceArtifactLabel: artifactLabelResult.data }),
    },
  };
}
