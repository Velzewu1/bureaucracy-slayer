import type { EvidenceResult, ProcedureModel } from "../contracts/index.js";
import type { EvidenceValidationContext } from "../evidence/index.js";

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
  createMessage(request: ClaudeMessageRequest): Promise<unknown>;
}>;

export type ExtractProcedureOptions = Readonly<{
  transport: ClaudeTransport;
  evidenceContext: EvidenceValidationContext;
  model?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  maxTokens?: number;
  maxTransientRetries?: 0 | 1;
}>;

export type ExtractionFailureCode =
  | "INPUT_INVALID"
  | "CONFIGURATION_INVALID"
  | "CLAUDE_REQUEST_FAILED"
  | "CLAUDE_RESPONSE_INVALID"
  | "PROCEDURE_SCHEMA_INVALID"
  | "EVIDENCE_VALIDATION_FAILED";

export type ExtractionFailure = Readonly<{
  ok: false;
  code: ExtractionFailureCode;
  stage: "input" | "configuration" | "transport" | "response" | "procedure_schema" | "evidence";
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
}>;

export type ExtractionOutcome = ExtractionFailure | ExtractionSuccess;

