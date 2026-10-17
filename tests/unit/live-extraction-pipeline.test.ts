import { describe, expect, it, vi } from "vitest";

import { CollectorError, CollectorErrorCode } from "../../src/collector/index.js";
import {
  selectFocusedSources,
  type ClaudeMessageRequest,
  type ClaudeTransport,
  type ExtractProcedureOptions,
  type ExtractionFailure,
} from "../../src/extractor/index.js";
import {
  LiveExtractionPipelineError,
  type LiveExtractionRunningPhase,
} from "../../src/orchestration/live-extraction-job-manager.js";
import {
  createLiveExtractionRunner,
  LIVE_EXTRACTION_GOAL,
} from "../../src/orchestration/live-extraction-pipeline.js";
import {
  LIVE_EXTRACTION_TEST_PORTAL_URL,
  liveExtractionArtifact,
} from "../live-extraction-test-helpers.js";

const LIVE_EXTRACTION_TEST_PORTAL_ORIGIN = "http://127.0.0.1:5180";

const ENVIRONMENT = {
  ANTHROPIC_API_KEY: "sk-ant-test-secret",
  ANTHROPIC_MODEL: "claude-sonnet-4-5",
  ANTHROPIC_MAX_TOKENS: "16000",
  COLLECTOR_TEST_URL: LIVE_EXTRACTION_TEST_PORTAL_URL,
} as const;

const transport: ClaudeTransport = {
  createMessage: () => Promise.reject(new Error("The fake extractor owns transport behavior.")),
};

describe("live extraction composition", () => {
  it("uses only the fixed portal, goal, scope, collector bounds, and zero retries", async () => {
    const fixture = liveExtractionArtifact();
    const collect = vi.fn(() => Promise.resolve(fixture.sourceSnapshot));
    const createTransport = vi.fn(() => Promise.resolve(transport));
    const extract = vi.fn(
      (
        snapshot: unknown,
        goal: unknown,
        options: ExtractProcedureOptions,
      ) => {
        const parsedSnapshot = fixture.sourceSnapshot;
        const sourceSelection = selectFocusedSources(
          parsedSnapshot,
          String(goal),
          options.sourceSelectionBudget,
          options.goalScope,
        );
        options.onDebugEvent?.({ kind: "source_selection", selection: sourceSelection });
        options.onDebugEvent?.({
          kind: "stage_outcome",
          stage: "policy_extraction",
          status: "valid",
          issues: [],
        });
        options.onDebugEvent?.({
          kind: "stage_outcome",
          stage: "procedure_mapping",
          status: "valid",
          issues: [],
        });
        expect(snapshot).toBe(fixture.sourceSnapshot);
        return Promise.resolve({
          ok: true as const,
          status: "review_required" as const,
          model: fixture.procedureModel,
          evidence: fixture.evidence,
          attempts: 2,
          sourceSelection,
        });
      },
    );
    const phases: LiveExtractionRunningPhase[] = [];
    const runner = createLiveExtractionRunner({
      environment: ENVIRONMENT,
      collect,
      createTransport,
      extract,
      now: () => new Date("2026-10-17T12:00:00.000Z"),
      createEvidenceResultId: () => "evidence_livejob01",
    });

    const result = await runner({
      deadlineAtMs: Date.now() + 180_000,
      setPhase: (phase) => phases.push(phase),
    });

    expect(collect).toHaveBeenCalledWith({
      startUrl: LIVE_EXTRACTION_TEST_PORTAL_URL,
      allowedOrigins: [LIVE_EXTRACTION_TEST_PORTAL_ORIGIN],
      maxPages: 12,
      maxDepth: 3,
      navigationTimeoutMs: 10_000,
      navigationRetries: 1,
      maxTextCharsPerPage: 30_000,
      maxBlocksPerPage: 200,
      maxActionsPerPage: 100,
      headless: true,
    });
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: ENVIRONMENT.ANTHROPIC_API_KEY,
        requestTimeoutMs: 180_000,
        maxRetries: 0,
      }),
    );
    expect(extract).toHaveBeenCalledWith(
      fixture.sourceSnapshot,
      LIVE_EXTRACTION_GOAL,
      expect.objectContaining({
        model: ENVIRONMENT.ANTHROPIC_MODEL,
        maxTokens: 16_000,
        maxTransientRetries: 0,
        goalScope: {
          primaryActionPurpose: "cancel the transfer",
          alternativeActionPurposes: ["request recovery"],
        },
      }),
    );
    expect(phases).toEqual([
      "collecting",
      "selecting_sources",
      "extracting_policy",
      "mapping_procedure",
      "validating",
      "validating",
    ]);
    expect(result).toMatchObject({
      goal: LIVE_EXTRACTION_GOAL,
      portalUrl: LIVE_EXTRACTION_TEST_PORTAL_URL,
      evidence: { status: "degraded" },
      provenance: {
        extractionType: "live",
        modelName: ENVIRONMENT.ANTHROPIC_MODEL,
      },
    });
    expect(JSON.stringify(result)).not.toContain(ENVIRONMENT.ANTHROPIC_API_KEY);
    expect(JSON.stringify(result)).not.toContain("messages");
    expect(JSON.stringify(result)).not.toContain("thinking");
  });

  it.each([
    [
      {
        ok: false,
        code: "CLAUDE_REQUEST_FAILED",
        stage: "transport",
        modelStage: "policy_extraction",
        message: "raw",
        issues: ["raw provider request req_secret"],
        attempts: 1,
      },
      "STAGE_1_TRANSPORT_FAILED",
    ],
    [
      {
        ok: false,
        code: "CLAUDE_RESPONSE_INVALID",
        stage: "response",
        modelStage: "policy_extraction",
        message: "raw",
        issues: ["raw response"],
        attempts: 1,
      },
      "STAGE_1_RESPONSE_INVALID",
    ],
    [
      {
        ok: false,
        code: "CLAUDE_REQUEST_FAILED",
        stage: "transport",
        modelStage: "procedure_mapping",
        message: "raw",
        issues: ["raw provider request req_secret"],
        attempts: 2,
      },
      "STAGE_2_TRANSPORT_FAILED",
    ],
    [
      {
        ok: false,
        code: "CLAUDE_RESPONSE_INVALID",
        stage: "response",
        modelStage: "procedure_mapping",
        message: "raw",
        issues: ["raw response"],
        attempts: 2,
      },
      "STAGE_2_RESPONSE_INVALID",
    ],
    [
      {
        ok: false,
        code: "POLICY_EXTRACTION_INVALID",
        stage: "policy_extraction",
        modelStage: "policy_extraction",
        message: "raw",
        issues: ["raw Stage 1 DTO"],
        attempts: 1,
      },
      "STAGE_1_OUTPUT_INVALID",
    ],
    [
      {
        ok: false,
        code: "PROCEDURE_MAPPING_INVALID",
        stage: "procedure_mapping",
        modelStage: "procedure_mapping",
        message: "raw",
        issues: ["raw Stage 2 DTO"],
        attempts: 2,
      },
      "STAGE_2_OUTPUT_INVALID",
    ],
    [
      {
        ok: false,
        code: "PROCEDURE_SCHEMA_INVALID",
        stage: "procedure_schema",
        message: "raw",
        issues: ["raw canonical model"],
        attempts: 2,
      },
      "PROCEDURE_SCHEMA_INVALID",
    ],
    [
      {
        ok: false,
        code: "EVIDENCE_VALIDATION_FAILED",
        stage: "evidence",
        message: "raw",
        issues: ["raw evidence"],
        attempts: 2,
      },
      "EVIDENCE_VALIDATION_FAILED",
    ],
    [
      {
        ok: false,
        code: "SOURCE_COVERAGE_INCOMPLETE",
        stage: "source_selection",
        message: "raw",
        issues: ["raw selected text"],
        attempts: 0,
      },
      "SOURCE_SELECTION_INCOMPLETE",
    ],
    [
      {
        ok: false,
        code: "CONFIGURATION_INVALID",
        stage: "configuration",
        message: "raw",
        issues: ["raw configuration"],
        attempts: 0,
      },
      "CONFIGURATION_INVALID",
    ],
    [
      {
        ok: false,
        code: "INPUT_INVALID",
        stage: "input",
        message: "raw",
        issues: ["raw snapshot"],
        attempts: 0,
      },
      "SNAPSHOT_INVALID",
    ],
  ] satisfies readonly (readonly [ExtractionFailure, string])[])(
    "maps partial extraction failure %# to %s without raw details",
    async (failure, expectedCode) => {
      const fixture = liveExtractionArtifact();
      const runner = createLiveExtractionRunner({
        environment: ENVIRONMENT,
        collect: () => Promise.resolve(fixture.sourceSnapshot),
        createTransport: () => Promise.resolve(transport),
        extract: () => Promise.resolve(failure),
      });

      let caught: unknown;
      try {
        await runner({
          deadlineAtMs: Date.now() + 180_000,
          setPhase: () => undefined,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(LiveExtractionPipelineError);
      if (!(caught instanceof LiveExtractionPipelineError)) return;
      expect(caught.failure.code).toBe(expectedCode);
      expect(caught.failure.issueCodes).toEqual([failure.code]);
      for (const issue of failure.issues) {
        expect(JSON.stringify(caught.failure)).not.toContain(issue);
      }
      expect(JSON.stringify(caught.failure)).not.toContain("req_secret");
      expect(JSON.stringify(caught.failure)).not.toContain("raw response");
      expect(JSON.stringify(caught.failure)).not.toContain("raw Stage");
    },
  );

  it.each([
    [CollectorErrorCode.browserLaunchFailed, "COLLECTOR_UNAVAILABLE"],
    [CollectorErrorCode.navigationFailed, "PORTAL_UNAVAILABLE"],
    [CollectorErrorCode.navigationTimeout, "PORTAL_UNAVAILABLE"],
    [CollectorErrorCode.pageUnavailable, "PORTAL_UNAVAILABLE"],
    [CollectorErrorCode.originDisallowed, "COLLECTION_SECURITY_BLOCKED"],
    [CollectorErrorCode.redirectDisallowed, "COLLECTION_SECURITY_BLOCKED"],
    [CollectorErrorCode.unsafeRequestBlocked, "COLLECTION_SECURITY_BLOCKED"],
    [CollectorErrorCode.snapshotSchemaInvalid, "SNAPSHOT_INVALID"],
    [CollectorErrorCode.invalidOptions, "COLLECTION_FAILED"],
    [CollectorErrorCode.invalidStartUrl, "COLLECTION_FAILED"],
  ])("maps collector failure %s to %s without exposing details", async (
    collectorCode,
    publicCode,
  ) => {
    const runner = createLiveExtractionRunner({
      environment: ENVIRONMENT,
      createTransport: () => Promise.resolve(transport),
      collect: () =>
        Promise.reject(
          new CollectorError(
            collectorCode,
            "collector detail https://attacker.example/?token=secret",
          ),
        ),
    });

    let caught: unknown;
    try {
      await runner({
        deadlineAtMs: Date.now() + 180_000,
        setPhase: () => undefined,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LiveExtractionPipelineError);
    if (!(caught instanceof LiveExtractionPipelineError)) return;
    expect(caught.failure).toMatchObject({
      code: publicCode,
      stage: "collector",
      issueCodes: [collectorCode],
    });
    expect(JSON.stringify(caught.failure)).not.toContain("attacker");
    expect(JSON.stringify(caught.failure)).not.toContain("secret");
  });

  it("rejects any configured portal override before collection", async () => {
    const collect = vi.fn();
    const runner = createLiveExtractionRunner({
      environment: {
        ...ENVIRONMENT,
        COLLECTOR_TEST_URL: "http://127.0.0.1:9999/private",
      },
      collect,
    });

    await expect(runner({
      deadlineAtMs: Date.now() + 180_000,
      setPhase: () => undefined,
    })).rejects.toMatchObject({
      failure: { code: "CONFIGURATION_INVALID" },
    });
    expect(collect).not.toHaveBeenCalled();
  });

  it("bounds each sequential Claude call by the remaining overall deadline", async () => {
    const fixture = liveExtractionArtifact();
    const startedAtMs = Date.parse("2026-10-17T12:00:00.000Z");
    let currentMs = startedAtMs;
    const timeoutOptions: unknown[] = [];
    const boundedTransport: ClaudeTransport = {
      createMessage: (_request, options) => {
        timeoutOptions.push(options);
        return Promise.resolve({});
      },
    };
    const request: ClaudeMessageRequest = {
      model: "claude-sonnet-test",
      max_tokens: 1_000,
      system: "test",
      messages: [{ role: "user", content: "test" }],
      output_config: { format: { type: "json_schema", schema: {} } },
    };
    const runner = createLiveExtractionRunner({
      environment: ENVIRONMENT,
      collect: () => Promise.resolve(fixture.sourceSnapshot),
      createTransport: () => Promise.resolve(boundedTransport),
      now: () => new Date(currentMs),
      extract: async (snapshot, goal, options) => {
        expect(snapshot).toBe(fixture.sourceSnapshot);
        await options.transport.createMessage(request);
        currentMs += 120_000;
        await options.transport.createMessage(request);
        return {
          ok: true,
          status: "review_required",
          model: fixture.procedureModel,
          evidence: fixture.evidence,
          attempts: 2,
          sourceSelection: selectFocusedSources(
            fixture.sourceSnapshot,
            String(goal),
            options.sourceSelectionBudget,
            options.goalScope,
          ),
        };
      },
    });

    await runner({
      deadlineAtMs: startedAtMs + 180_000,
      setPhase: () => undefined,
    });

    expect(timeoutOptions).toEqual([
      { timeoutMs: 180_000 },
      { timeoutMs: 60_000 },
    ]);
  });
});
