import type { EvidenceResult, ProcedureModel } from "../contracts/index.js";
import type { EvidenceValidationContext } from "../evidence/index.js";
import type {
  FocusedSourceCatalog,
  GoalScopedExtraction,
  SourceSelectionBudget,
} from "./source-selection.js";
import type {
  PolicyExtractionNormalization,
  StagedConversionNormalization,
} from "./staged.js";
import type { ClaudeResponseMetadata } from "./response.js";

export type ClaudeMessageRequest = Readonly<{
  model: string;
  max_tokens: number;
  system: string;
  messages: readonly [Readonly<{ role: "user"; content: string }>];
  output_config: Readonly<{
    format: Readonly<{
      type: "json_schema";
      schema: Readonly<Record<string, unknown>>;
    }>;
  }>;
}>;

export type ClaudeTransport = Readonly<{
  createMessage(
    request: ClaudeMessageRequest,
    options?: Readonly<{ timeoutMs?: number }>,
  ): Promise<unknown>;
}>;

export type ExtractionDebugEvent =
  | Readonly<{ kind: "source_selection"; selection: FocusedSourceCatalog }>
  | Readonly<{
      kind: "claude_response_metadata";
      stage: "policy_extraction" | "procedure_mapping";
      metadata: ClaudeResponseMetadata;
    }>
  | Readonly<{
      kind: "snapshot_reference_catalog";
      pages: readonly Readonly<{
        pageId: string;
        blockIds: readonly string[];
        websiteActionIds: readonly string[];
      }>[];
    }>
  | Readonly<{ kind: "compact_dto"; compactDto: unknown }>
  | Readonly<{ kind: "policy_dto"; policyDto: unknown }>
  | Readonly<{
      kind: "policy_normalization";
      normalizations: readonly PolicyExtractionNormalization[];
    }>
  | Readonly<{ kind: "procedure_mapping_dto"; procedureMappingDto: unknown }>
  | Readonly<{
      kind: "stage_outcome";
      stage: "policy_extraction" | "procedure_mapping" | "canonical_schema";
      status: "valid" | "failed";
      issues: readonly string[];
    }>
  | Readonly<{
      kind: "conversion_normalization";
      normalizations: readonly StagedConversionNormalization[];
    }>
  | Readonly<{
      kind: "conversion_failure";
      conversionStage: "compact_schema" | "conversion" | "canonical_schema";
      issues: readonly string[];
    }>
  | Readonly<{
      kind: "canonical_model";
      procedureModelId: string;
      procedureActions: readonly Readonly<{
        id: string;
        kind: "navigate" | "interact" | "user_task";
        websiteActionId?: string;
      }>[];
      ruleIds: readonly string[];
    }>
  | Readonly<{ kind: "evidence_validation_failure"; issues: readonly string[] }>
  | Readonly<{ kind: "evidence_validation"; evidence: EvidenceResult }>;

export type ExtractProcedureOptions = Readonly<{
  transport: ClaudeTransport;
  evidenceContext: EvidenceValidationContext;
  model?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  maxTokens?: number;
  maxTransientRetries?: 0 | 1;
  sourceSelectionBudget?: SourceSelectionBudget;
  goalScope?: GoalScopedExtraction;
  onDebugEvent?: (event: ExtractionDebugEvent) => void;
}>;

export type ResumeProcedureMappingOptions = Readonly<{
  transport: ClaudeTransport;
  evidenceContext: EvidenceValidationContext;
  model?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  maxTokens?: number;
  maxTransientRetries?: 0 | 1;
  sourceArtifactLabel?: string;
  onDebugEvent?: (event: ExtractionDebugEvent) => void;
}>;

export type ExtractionFailureCode =
  | "INPUT_INVALID"
  | "CONFIGURATION_INVALID"
  | "SOURCE_COVERAGE_INCOMPLETE"
  | "CLAUDE_REQUEST_FAILED"
  | "CLAUDE_RESPONSE_INVALID"
  | "POLICY_EXTRACTION_INVALID"
  | "PROCEDURE_MAPPING_INVALID"
  | "PROCEDURE_SCHEMA_INVALID"
  | "EVIDENCE_VALIDATION_FAILED";

export type ExtractionFailure = Readonly<{
  ok: false;
  code: ExtractionFailureCode;
  stage:
    | "input"
    | "configuration"
    | "source_selection"
    | "transport"
    | "response"
    | "policy_extraction"
    | "procedure_mapping"
    | "procedure_schema"
    | "evidence";
  modelStage?: "policy_extraction" | "procedure_mapping";
  message: string;
  issues: readonly string[];
  attempts: number;
}>;

export type ExtractionSuccess = Readonly<{
  ok: true;
  status: "evidence_valid" | "review_required";
  model: ProcedureModel;
  evidence: EvidenceResult;
  attempts: number;
  sourceSelection: FocusedSourceCatalog;
}>;

export type ExtractionOutcome = ExtractionFailure | ExtractionSuccess;

export type SavedStage1Provenance = Readonly<{
  stage1Source: "saved_artifact";
  policyAnalysisId: string;
  sourceSnapshotId: string;
  sourceSnapshotHash: string;
  sourceArtifactLabel?: string;
}>;

export type ResumedExtractionSuccess = ExtractionSuccess &
  Readonly<{ provenance: SavedStage1Provenance }>;

export type ResumedExtractionOutcome = ExtractionFailure | ResumedExtractionSuccess;

