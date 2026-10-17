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

export const LIVE_EXTRACTION_GOAL =
  "I sent an $850 transfer to the wrong recipient. Can I cancel it? If not, what are my alternatives?";
export const LIVE_EXTRACTION_API_HOST = "127.0.0.1";
export const LIVE_EXTRACTION_API_PORT = 5_190;
export const LIVE_EXTRACTION_UI_ORIGIN = "http://127.0.0.1:5173";

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
    case "CLAUDE_REQUEST_FAILED": {
      const stage = outcome.modelStage;
      return pipelineFailure({
        code:
          stage === "procedure_mapping"
            ? "STAGE_2_TRANSPORT_FAILED"
            : "STAGE_1_TRANSPORT_FAILED",
        stage:
          stage === "procedure_mapping"
            ? "procedure_mapping"
            : "policy_extraction",
        message:
          stage === "procedure_mapping"
            ? "Procedure mapping transport failed."
            : "Policy extraction transport failed.",
        // Extraction failures do not expose structured provider retryability.
        // Fail closed instead of inviting another paid request after a permanent error.
        retryable: false,
        issueCodes,
      });
    }
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
      return pipelineFailure({
        code: "PROCEDURE_SCHEMA_INVALID",
        stage: "procedure_schema",
        message: "The canonical procedure model was invalid.",
        retryable: false,
        issueCodes,
      });
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

    context.setPhase("collecting");
    let snapshot: SiteSnapshot;
    try {
      snapshot = await collect(collectorOptions(configured));
    } catch (error) {
      throw collectorFailure(error);
    }

    context.setPhase("selecting_sources");
    const extraction = await extract(snapshot, LIVE_EXTRACTION_GOAL, {
      transport: deadlineBoundTransport(transport, context, now),
      model: configured.model,
      maxTokens: configured.maxTokens,
      maxTransientRetries: 0,
      goalScope: {
        primaryActionPurpose: "cancel the transfer",
        alternativeActionPurposes: ["request recovery"],
      },
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
      goal: LIVE_EXTRACTION_GOAL,
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
