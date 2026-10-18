import { randomBytes } from "node:crypto";

import {
  collectWebsite,
  CollectorError,
  CollectorErrorCode,
  type CollectorOptions,
} from "../collector/index.js";
import type { SiteSnapshot } from "../contracts/index.js";
import {
  auditSemanticQualifiers,
  ClaudeTransportError,
  createAnthropicTransport,
  extractProcedure,
  deriveObservedGoalScope,
  parseAnthropicMaxTokens,
  type AnthropicTransportOptions,
  type ClaudeTransport,
  type ExtractProcedureOptions,
  type ExtractionDebugEvent,
  type ExtractionFailure,
  type ExtractionOutcome,
} from "../extractor/index.js";
import {
  LIVE_EXTRACTION_JOB_TIMEOUT_MS,
  LIVE_EXTRACTION_LEGACY_GOAL,
  LiveExtractionArtifactSchema,
  type LiveExtractionArtifact,
  type LiveExtractionFailure,
  type LiveSourceSelectionSummary,
} from "./live-extraction-contract.js";
import {
  LiveExtractionPipelineError,
  type LiveExtractionRunContext,
  type LiveExtractionRunner,
} from "./live-extraction-job-manager.js";

export const LIVE_EXTRACTION_GOAL = LIVE_EXTRACTION_LEGACY_GOAL;
export const LIVE_EXTRACTION_API_HOST = "127.0.0.1";
export const LIVE_EXTRACTION_API_PORT = 5_190;
export const LIVE_EXTRACTION_UI_ORIGIN = "http://127.0.0.1:5173";
export const LIVE_EXTRACTION_SOURCE_BUDGET = Object.freeze({
  maxPages: 9,
  maxBlocks: 80,
  maxActions: 35,
});

type Environment = Readonly<Record<string, string | undefined>>;

export type LiveExtractionPipelineDependencies = Readonly<{
  environment?: Environment;
  /** Server-owned exact collection target, captured when the runner is created. */
  allowedPortalUrl: string;
  collect?: (options: CollectorOptions) => Promise<SiteSnapshot>;
  extract?: (
    snapshot: unknown,
    goal: unknown,
    options: ExtractProcedureOptions,
  ) => Promise<ExtractionOutcome>;
  createTransport?: (options: AnthropicTransportOptions) => Promise<ClaudeTransport>;
  now?: () => Date;
  createEvidenceResultId?: () => string;
}>;

type LiveConfiguration = Readonly<{
  apiKey: string;
  model: string;
  maxTokens: number;
  portalUrl: string;
  portalOrigin: string;
}>;

function pipelineFailure(
  failure: LiveExtractionFailure,
): LiveExtractionPipelineError {
  return new LiveExtractionPipelineError(failure);
}

function safePortalUrl(value: string | undefined): URL | undefined {
  const candidate = value?.trim();
  if (candidate === undefined || candidate.length === 0) return undefined;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== "5180" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function configuredPortal(
  environment: Environment,
  allowedPortalUrl: string | undefined,
): Readonly<{
  portalUrl: string;
  portalOrigin: string;
}> | undefined {
  const allowed = safePortalUrl(allowedPortalUrl);
  const configured = safePortalUrl(environment["COLLECTOR_TEST_URL"]);
  if (allowed === undefined || configured === undefined || configured.href !== allowed.href) {
    return undefined;
  }
  return { portalUrl: configured.href, portalOrigin: configured.origin };
}

function configuration(
  environment: Environment,
  allowedPortalUrl: string | undefined,
): LiveConfiguration {
  const apiKey = environment["ANTHROPIC_API_KEY"]?.trim();
  const model = environment["ANTHROPIC_MODEL"]?.trim();
  const portal = configuredPortal(environment, allowedPortalUrl);
  const tokenResult =
    model === undefined || model.length === 0
      ? undefined
      : parseAnthropicMaxTokens(environment["ANTHROPIC_MAX_TOKENS"], model);
  if (
    apiKey === undefined ||
    apiKey.length === 0 ||
    model === undefined ||
    model.length === 0 ||
    tokenResult === undefined ||
    !tokenResult.ok ||
    portal === undefined
  ) {
    throw pipelineFailure({
      code: "CONFIGURATION_INVALID",
      stage: "internal",
      message: "The live extraction server configuration is invalid.",
      retryable: false,
      issueCodes: ["CONFIGURATION_INVALID"],
    });
  }
  return { apiKey, model, maxTokens: tokenResult.value, ...portal };
}

function collectorOptions(configured: LiveConfiguration): CollectorOptions {
  return {
    startUrl: configured.portalUrl,
    allowedOrigins: [configured.portalOrigin],
    maxPages: 12,
    maxDepth: 3,
    navigationTimeoutMs: 10_000,
    navigationRetries: 1,
    maxTextCharsPerPage: 30_000,
    maxBlocksPerPage: 200,
    maxActionsPerPage: 100,
    headless: true,
  };
}

function deadlineBoundTransport(
  transport: ClaudeTransport,
  context: LiveExtractionRunContext,
  now: () => Date,
): ClaudeTransport {
  return {
    createMessage: (request) => {
      const remainingMs = Math.floor(context.deadlineAtMs - now().getTime());
      if (remainingMs <= 0) {
        return Promise.reject(
          new ClaudeTransportError(
            "The live extraction deadline elapsed before the Claude request could start.",
            false,
          ),
        );
      }
      return transport.createMessage(request, {
        timeoutMs: Math.min(remainingMs, LIVE_EXTRACTION_JOB_TIMEOUT_MS),
      });
    },
  };
}

function collectorFailure(error: unknown): LiveExtractionPipelineError {
  if (!(error instanceof CollectorError)) {
    return pipelineFailure({
      code: "COLLECTION_FAILED",
      stage: "collector",
      message: "Website collection failed.",
      retryable: false,
      issueCodes: [],
    });
  }

  const common = { issueCodes: [error.code] };
  switch (error.code) {
    case CollectorErrorCode.browserLaunchFailed:
      return pipelineFailure({
        ...common,
        code: "COLLECTOR_UNAVAILABLE",
        stage: "collector",
        message: "The local browser collector is unavailable.",
        retryable: true,
      });
    case CollectorErrorCode.navigationFailed:
    case CollectorErrorCode.navigationTimeout:
    case CollectorErrorCode.pageUnavailable:
      return pipelineFailure({
        ...common,
        code: "PORTAL_UNAVAILABLE",
        stage: "collector",
        message: "The controlled Northstar Mock Bank portal is unavailable.",
        retryable: true,
      });
    case CollectorErrorCode.originDisallowed:
    case CollectorErrorCode.redirectDisallowed:
    case CollectorErrorCode.unsafeRequestBlocked:
      return pipelineFailure({
        ...common,
        code: "COLLECTION_SECURITY_BLOCKED",
        stage: "collector",
        message: "Collection was blocked by the fixed-origin security policy.",
        retryable: false,
      });
    case CollectorErrorCode.snapshotSchemaInvalid:
      return pipelineFailure({
        ...common,
        code: "SNAPSHOT_INVALID",
        stage: "collector",
        message: "The collected website snapshot was invalid.",
        retryable: false,
      });
    case CollectorErrorCode.invalidOptions:
    case CollectorErrorCode.invalidStartUrl:
      return pipelineFailure({
        ...common,
        code: "COLLECTION_FAILED",
        stage: "collector",
        message: "Website collection could not be configured safely.",
        retryable: false,
      });
  }
}

function diagnosticField(issues: readonly string[], label: string): string | undefined {
  const prefix = `${label}: `;
  const line = issues.find((issue) => issue.startsWith(prefix));
  return line === undefined ? undefined : line.slice(prefix.length);
}

/**
 * Turns sanitized transport diagnostics into a stable category. Raw provider
 * text is never copied into the client-facing message.
 */
function presentTransportFailure(outcome: ExtractionFailure): LiveExtractionFailure {
  const mapping = outcome.modelStage === "procedure_mapping";
  const label = mapping ? "Procedure mapping" : "Policy extraction";
  const code = mapping ? "STAGE_2_TRANSPORT_FAILED" : "STAGE_1_TRANSPORT_FAILED";
  const stage = mapping ? "procedure_mapping" : "policy_extraction";
  const errorClass = diagnosticField(outcome.issues, "Error class");
  const httpStatus = diagnosticField(outcome.issues, "HTTP status");
  const providerCode = diagnosticField(outcome.issues, "Anthropic error code");
  const detail = (diagnosticField(outcome.issues, "Message") ?? "").toLowerCase();

  if (detail.includes("deadline elapsed")) {
    return {
      code: "JOB_TIMED_OUT",
      stage: "timeout",
      message: "The extraction deadline elapsed before the model request could start.",
      retryable: false,
      issueCodes: ["JOB_DEADLINE_ELAPSED"],
    };
  }
  if (errorClass === "APIConnectionTimeoutError") {
    return {
      code,
      stage,
      message: `${label} timed out before the model provider responded.`,
      retryable: false,
      issueCodes: [outcome.code, "UPSTREAM_TIMEOUT"],
    };
  }
  if (
    providerCode === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    providerCode === "CERT_SIGNATURE_FAILURE" ||
    detail.includes("unable to verify the first certificate") ||
    detail.includes("certificate")
  ) {
    return {
      code,
      stage,
      message: `${label} could not verify the model provider certificate. The request was not retried.`,
      retryable: false,
      issueCodes: [outcome.code, "UPSTREAM_TLS_FAILED"],
    };
  }
  if (errorClass === "APIConnectionError") {
    return {
      code,
      stage,
      message: `${label} could not connect to the model provider.`,
      retryable: false,
      issueCodes: [outcome.code, "UPSTREAM_CONNECTION_FAILED"],
    };
  }
  if (httpStatus !== undefined) {
    return {
      code,
      stage,
      message: `${label} was rejected by the model provider.`,
      retryable: false,
      issueCodes: [outcome.code, "UPSTREAM_REJECTED"],
    };
  }
  if (detail.includes("timed out") || detail.includes("timeout")) {
    return {
      code,
      stage,
      message: `${label} timed out before the model provider responded.`,
      retryable: false,
      issueCodes: [outcome.code, "UPSTREAM_TIMEOUT"],
    };
  }
  return {
    code,
    stage,
    message: `${label} transport failed.`,
    retryable: false,
    issueCodes: [outcome.code],
  };
}

function presentSchemaFailure(outcome: ExtractionFailure): LiveExtractionFailure {
  const identifierInvalid =
    outcome.issues.length > 0 &&
    outcome.issues.every((issue) =>
      /(?:^|\.)id: Invalid string: must match pattern /u.test(issue),
    );
  if (identifierInvalid) {
    return {
      code: "PROCEDURE_SCHEMA_INVALID",
      stage: "procedure_schema",
      message:
        "The canonical procedure model was invalid because generated identifiers did not match the required form.",
      retryable: false,
      issueCodes: ["PROCEDURE_SCHEMA_INVALID", "CANONICAL_IDENTIFIER_INVALID"],
    };
  }
  const snapshotMismatch = outcome.issues.some(
    (issue) => issue.includes("sourceSnapshotId") || issue.includes("sourceSnapshotHash"),
  );
  if (snapshotMismatch) {
    return {
      code: "PROCEDURE_SCHEMA_INVALID",
      stage: "procedure_schema",
      message:
        "The canonical procedure model was invalid because it did not match the collected snapshot.",
      retryable: false,
      issueCodes: ["PROCEDURE_SCHEMA_INVALID", "SNAPSHOT_IDENTITY_MISMATCH"],
    };
  }
  return {
    code: "PROCEDURE_SCHEMA_INVALID",
    stage: "procedure_schema",
    message: "The canonical procedure model was invalid.",
    retryable: false,
    issueCodes: ["PROCEDURE_SCHEMA_INVALID"],
  };
}

function extractionFailure(outcome: ExtractionFailure): LiveExtractionPipelineError {
  const issueCodes = [outcome.code];
  switch (outcome.code) {
    case "CONFIGURATION_INVALID":
      return pipelineFailure({
        code: "CONFIGURATION_INVALID",
        stage: "internal",
        message: "The extraction pipeline configuration was invalid.",
        retryable: false,
        issueCodes,
      });
    case "SOURCE_COVERAGE_INCOMPLETE":
      return pipelineFailure({
        code: "SOURCE_SELECTION_INCOMPLETE",
        stage: "source_selection",
        message: "Goal-scoped source selection was incomplete.",
        retryable: false,
        issueCodes,
      });
    case "CLAUDE_REQUEST_FAILED":
      // Diagnostics choose the category. Retryability stays closed: a failed
      // live request must not invite another paid call.
      return pipelineFailure(presentTransportFailure(outcome));
    case "CLAUDE_RESPONSE_INVALID": {
      const stage = outcome.modelStage;
      return pipelineFailure({
        code:
          stage === "procedure_mapping"
            ? "STAGE_2_RESPONSE_INVALID"
            : "STAGE_1_RESPONSE_INVALID",
        stage:
          stage === "procedure_mapping"
            ? "procedure_mapping"
            : "policy_extraction",
        message:
          stage === "procedure_mapping"
            ? "Procedure mapping returned an invalid structured response."
            : "Policy extraction returned an invalid structured response.",
        retryable: false,
        issueCodes,
      });
    }
    case "POLICY_EXTRACTION_INVALID":
      return pipelineFailure({
        code: "STAGE_1_OUTPUT_INVALID",
        stage: "policy_extraction",
        message: "Policy extraction output failed deterministic validation.",
        retryable: false,
        issueCodes,
      });
    case "PROCEDURE_MAPPING_INVALID":
      return pipelineFailure({
        code: "STAGE_2_OUTPUT_INVALID",
        stage: "procedure_mapping",
        message: "Procedure mapping output failed deterministic validation.",
        retryable: false,
        issueCodes,
      });
    case "PROCEDURE_SCHEMA_INVALID":
      return pipelineFailure(presentSchemaFailure(outcome));
    case "EVIDENCE_VALIDATION_FAILED":
      return pipelineFailure({
        code: "EVIDENCE_VALIDATION_FAILED",
        stage: "evidence",
        message: "Evidence validation could not process the canonical artifacts.",
        retryable: false,
        issueCodes,
      });
    case "INPUT_INVALID":
      return pipelineFailure({
        code: "SNAPSHOT_INVALID",
        stage: "collector",
        message: "The collected website snapshot was invalid.",
        retryable: false,
        issueCodes,
      });
  }
}

function sourceSelectionSummary(
  outcome: Extract<ExtractionOutcome, { ok: true }>,
): LiveSourceSelectionSummary {
  const selection = outcome.sourceSelection;
  return {
    sourceSnapshotId: selection.sourceSnapshotId,
    sourceSnapshotHash: selection.sourceSnapshotHash,
    userGoal: selection.userGoal,
    selectionMode: "goal_scoped",
    semanticCoverage: "not_verified",
    coverage: "complete",
    limitations: [],
    originalCounts: selection.originalCounts,
    selectedCounts: selection.selectedCounts,
    selectedPageIds: selection.pages.map((page) => page.pageId),
  };
}

function phaseFromEvent(
  event: ExtractionDebugEvent,
  context: LiveExtractionRunContext,
): void {
  if (event.kind === "source_selection") {
    if (event.selection.coverage === "complete") context.setPhase("extracting_policy");
    return;
  }
  if (
    event.kind === "stage_outcome" &&
    event.stage === "policy_extraction" &&
    event.status === "valid"
  ) {
    context.setPhase("mapping_procedure");
    return;
  }
  if (
    event.kind === "stage_outcome" &&
    event.stage === "procedure_mapping" &&
    event.status === "valid"
  ) {
    context.setPhase("validating");
  }
}

function defaultEvidenceResultId(): string {
  return `evidence_${randomBytes(16).toString("hex")}`;
}

export function createLiveExtractionRunner(
  dependencies: LiveExtractionPipelineDependencies,
): LiveExtractionRunner {
  const environment = dependencies.environment ?? process.env;
  // Capture the trusted startup target once. Tests and alternate composition
  // roots can inject it without hardcoding a mock-portal route in production.
  const allowedPortalUrl = dependencies.allowedPortalUrl;
  const collect = dependencies.collect ?? collectWebsite;
  const extract = dependencies.extract ?? extractProcedure;
  const createTransport = dependencies.createTransport ?? createAnthropicTransport;
  const now = dependencies.now ?? (() => new Date());
  const createEvidenceResultId =
    dependencies.createEvidenceResultId ?? defaultEvidenceResultId;

  return async (context): Promise<LiveExtractionArtifact> => {
    const configured = configuration(environment, allowedPortalUrl);
    context.setPhase("collecting");
    let snapshot: SiteSnapshot;
    try {
      snapshot = await collect(collectorOptions(configured));
    } catch (error) {
      throw collectorFailure(error);
    }

    context.setPhase("selecting_sources");
    const goalScope =
      context.goal === LIVE_EXTRACTION_LEGACY_GOAL
        ? {
            primaryActionPurpose: "cancel the transfer",
            alternativeActionPurposes: ["request recovery"],
          }
        : deriveObservedGoalScope(snapshot, context.goal);
    if (goalScope === undefined) {
      throw pipelineFailure({
        code: "SOURCE_SELECTION_INCOMPLETE",
        stage: "source_selection",
        message: "No observed website action was sufficiently grounded in the requested goal.",
        retryable: false,
        issueCodes: ["NO_GROUNDED_WEBSITE_ACTION"],
      });
    }

    let transport: ClaudeTransport;
    try {
      transport = await createTransport({
        apiKey: configured.apiKey,
        environment,
        requestTimeoutMs: LIVE_EXTRACTION_JOB_TIMEOUT_MS,
        maxRetries: 0,
      });
    } catch {
      throw pipelineFailure({
        code: "CONFIGURATION_INVALID",
        stage: "internal",
        message: "The Anthropic transport could not be configured.",
        retryable: false,
        issueCodes: ["CONFIGURATION_INVALID"],
      });
    }

    const extraction = await extract(snapshot, context.goal, {
      transport: deadlineBoundTransport(transport, context, now),
      model: configured.model,
      maxTokens: configured.maxTokens,
      maxTransientRetries: 0,
      sourceSelectionBudget: LIVE_EXTRACTION_SOURCE_BUDGET,
      goalScope,
      evidenceContext: {
        evidenceResultId: createEvidenceResultId(),
        checkedAt: now().toISOString(),
      },
      onDebugEvent: (event) => phaseFromEvent(event, context),
    });
    if (!extraction.ok) throw extractionFailure(extraction);

    context.setPhase("validating");
    const semanticAudit = auditSemanticQualifiers(snapshot, extraction.model);
    const completedAt = now().toISOString();
    return LiveExtractionArtifactSchema.parse({
      schemaVersion: 1,
      artifactKind: "live_sonnet_extraction",
      goal: context.goal,
      portalUrl: configured.portalUrl,
      sourceSnapshot: snapshot,
      procedureModel: extraction.model,
      evidence: extraction.evidence,
      sourceSelection: sourceSelectionSummary(extraction),
      semanticAudit,
      provenance: {
        extractionType: "live",
        modelName: configured.model,
        completedAt,
      },
    });
  };
}
