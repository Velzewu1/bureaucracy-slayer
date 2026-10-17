import { z } from "zod";

import {
  IdSchema,
  IsoDateTimeSchema,
  ProcedureModelSchema,
  SiteSnapshotSchema,
} from "../contracts/index.js";
import { validateEvidence } from "../evidence/index.js";
import { ClaudeTransportError } from "./anthropic.js";
import { buildExtractionRequest } from "./prompt.js";
import { parseClaudeStructuredResponse } from "./response.js";
import type {
  ClaudeMessageRequest,
  ExtractProcedureOptions,
  ExtractionFailure,
  ExtractionOutcome,
} from "./types.js";

const UserGoalSchema = z.string().trim().min(1).max(2_000);
const ModelNameSchema = z.string().trim().min(1).max(200);
const MaxTokensSchema = z.number().int().min(256).max(64_000);
const EvidenceContextSchema = z
  .object({
    evidenceResultId: IdSchema,
    checkedAt: IsoDateTimeSchema,
  })
  .strict();

function zodIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`);
}

function failure(
  code: ExtractionFailure["code"],
  stage: ExtractionFailure["stage"],
  message: string,
  issues: readonly string[],
  attempts: number,
): ExtractionFailure {
  return { ok: false, code, stage, message, issues, attempts };
}

function configuredModel(options: ExtractProcedureOptions): string | undefined {
  const environment = options.environment ?? process.env;
  return options.model?.trim() || environment["ANTHROPIC_MODEL"]?.trim();
}

async function callTransport(
  request: ClaudeMessageRequest,
  options: ExtractProcedureOptions,
): Promise<Readonly<{ ok: true; response: unknown; attempts: number }> | ExtractionFailure> {
  const maxAttempts = 1 + (options.maxTransientRetries ?? 0);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return { ok: true, response: await options.transport.createMessage(request), attempts: attempt };
    } catch (error) {
      const retryable = error instanceof ClaudeTransportError && error.retryable;
      if (!retryable || attempt === maxAttempts) {
        return failure(
          "CLAUDE_REQUEST_FAILED",
          "transport",
          "Claude extraction was unavailable; no ProcedureModel was produced.",
          [retryable ? "A transient Claude request failure exhausted the configured retry limit." : "The Claude request failed."],
          attempt,
        );
      }
    }
  }
  return failure("CLAUDE_REQUEST_FAILED", "transport", "Claude extraction failed.", [], maxAttempts);
}

/**
 * Probabilistic interpretation boundary: SiteSnapshot + user goal -> candidate
 * ProcedureModel plus deterministic evidence validation. This function never
 * evaluates policy, plans a route, or authorizes an action.
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
  if (!modelResult.success || !tokensResult.success || !evidenceContextResult.success) {
    const issues = [
      ...(modelResult.success ? [] : zodIssues(modelResult.error)),
      ...(tokensResult.success ? [] : zodIssues(tokensResult.error)),
      ...(evidenceContextResult.success ? [] : zodIssues(evidenceContextResult.error)),
    ];
    return failure(
      "CONFIGURATION_INVALID",
      "configuration",
      "A Claude model name and valid token bound are required.",
      issues,
      0,
    );
  }

  const request = buildExtractionRequest(
    snapshotResult.data,
    goalResult.data,
    modelResult.data,
    tokensResult.data,
  );
  const transportResult = await callTransport(request, options);
  if (!transportResult.ok) return transportResult;

  const responseResult = parseClaudeStructuredResponse(transportResult.response);
  if (!responseResult.ok) {
    return failure(
      "CLAUDE_RESPONSE_INVALID",
      "response",
      "Claude did not return one complete structured JSON response.",
      responseResult.issues,
      transportResult.attempts,
    );
  }

  const procedureResult = ProcedureModelSchema.safeParse(responseResult.value);
  if (!procedureResult.success) {
    return failure(
      "PROCEDURE_SCHEMA_INVALID",
      "procedure_schema",
      "Claude output did not satisfy the canonical ProcedureModel schema.",
      zodIssues(procedureResult.error),
      transportResult.attempts,
    );
  }

  const validation = validateEvidence(
    snapshotResult.data,
    procedureResult.data,
    evidenceContextResult.data,
  );
  if (!validation.ok) {
    return failure(
      "EVIDENCE_VALIDATION_FAILED",
      "evidence",
      "The parsed artifacts could not be processed by the evidence validator.",
      validation.issues,
      transportResult.attempts,
    );
  }

  return {
    ok: true,
    status: validation.evidence.status === "valid" ? "evidence_valid" : "review_required",
    model: validation.model,
    evidence: validation.evidence,
    attempts: transportResult.attempts,
  };
}
