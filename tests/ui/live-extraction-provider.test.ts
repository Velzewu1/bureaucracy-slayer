import { describe, expect, it, vi } from "vitest";

import {
  UserStateSchema,
  type ProcedureModel,
  type SiteSnapshot,
} from "../../src/contracts/index.js";
import { validateEvidence } from "../../src/evidence/index.js";
import { auditSemanticQualifiers } from "../../src/extractor/semantic-audit.js";
import {
  LiveExtractionArtifactSchema,
  LiveExtractionStartRequestSchema,
  type LiveExtractionArtifact,
} from "../../src/orchestration/live-extraction-contract.js";
import {
  hashEvidenceBlockText,
  hashPageSnapshotContent,
  hashSiteSnapshotContent,
  hashWebsiteActionFingerprint,
} from "../../src/shared/index.js";
import {
  LIVE_DEMO_GOAL,
  LIVE_DEMO_PORTAL_URL,
  LiveExtractionClientError,
  LiveExtractionProvider,
} from "../../src/ui/adapters/liveExtractionProvider.js";
import {
  LiveArtifactIntegrityError,
  verifyLiveExtractionArtifact,
} from "../../src/ui/adapters/liveArtifactVerification.js";
import { recordedExtractionBundle } from "../../src/ui/adapters/recordedExtractionProvider.js";
import {
  demoProcedureModel,
  demoSnapshot,
  scheduledInstantState,
  scheduledStandardState,
} from "../../src/ui/fixtures/demoArtifacts.js";
import {
  applyAnalysisResult,
  createModeWorkspaceState,
  failModeAnalysis,
} from "../../src/ui/modeState.js";

const requestId = "request_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const jobId = "job_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
const createdAt = "2026-10-17T12:00:00.000Z";
const completedAt = "2026-10-17T12:01:00.000Z";
const expiresAt = "2026-10-17T12:16:00.000Z";
const fixedNow = () => completedAt;

function localUrl(url: string): string {
  const parsed = new URL(url);
  return new URL(`${parsed.pathname}${parsed.search}`, LIVE_DEMO_PORTAL_URL).toString();
}

function canonicalDemoArtifacts(): Readonly<{
  snapshot: SiteSnapshot;
  model: ProcedureModel;
}> {
  const snapshotInput = structuredClone(demoSnapshot);
  snapshotInput.rootUrl = LIVE_DEMO_PORTAL_URL;
  const generalBlock = snapshotInput.pages
    .flatMap((page) => page.blocks)
    .find((block) => block.id === "block_general01");
  const instantBlock = snapshotInput.pages
    .flatMap((page) => page.blocks)
    .find((block) => block.id === "block_instant01");
  if (generalBlock === undefined || instantBlock === undefined) {
    throw new Error("Demo policy blocks are unavailable");
  }
  generalBlock.text =
    "Standard scheduled transfers may be canceled before processing begins. Instant transfers cannot be canceled after verification has begun.";
  instantBlock.text = "Additional transfer policy details.";
  for (const page of snapshotInput.pages) {
    page.url = localUrl(page.url);
    page.canonicalUrl = localUrl(page.canonicalUrl);
    for (const block of page.blocks) {
      block.textHash = hashEvidenceBlockText(block.text);
    }
    for (const action of page.actions) {
      if (action.targetUrl !== undefined) action.targetUrl = localUrl(action.targetUrl);
      action.fingerprint = hashWebsiteActionFingerprint(action);
    }
    page.contentHash = hashPageSnapshotContent(page);
  }
  snapshotInput.contentHash = hashSiteSnapshotContent(snapshotInput);

  const modelInput = structuredClone(demoProcedureModel);
  modelInput.sourceSnapshotId = snapshotInput.id;
  modelInput.sourceSnapshotHash = snapshotInput.contentHash;
  for (const rule of modelInput.rules) {
    if (rule.id === "rule_cancelpermit1") {
      const citation = rule.citations[0];
      if (citation === undefined) throw new Error("Standard permit citation is unavailable");
      citation.excerpt =
        "Standard scheduled transfers may be canceled before processing begins.";
    }
    if (rule.id === "rule_instantdeny1") {
      const citation = rule.citations[0];
      if (citation === undefined) throw new Error("Instant prohibition citation is unavailable");
      citation.blockId = "block_general01";
      citation.excerpt =
        "Instant transfers cannot be canceled after verification has begun.";
    }
    for (const citation of rule.citations) {
      const page = snapshotInput.pages.find((candidate) => candidate.id === citation.pageId);
      if (page === undefined) throw new Error(`Missing test page ${citation.pageId}`);
      citation.pageUrl = page.url;
    }
  }
  return { snapshot: snapshotInput, model: modelInput };
}

function demoLiveArtifact(): LiveExtractionArtifact {
  const { snapshot, model } = canonicalDemoArtifacts();
  const semanticAudit = auditSemanticQualifiers(snapshot, model);
  const validation = validateEvidence(
    snapshot,
    model,
    {
      evidenceResultId: "evidence_live_demo_0001",
      checkedAt: completedAt,
    },
    semanticAudit.findings.map((finding) => ({
      ruleId: finding.ruleId,
      message: finding.message,
    })),
  );
  if (!validation.ok) throw new Error(`Test artifact failed ${validation.stage}`);
  const counts = {
    pages: snapshot.pages.length,
    blocks: snapshot.pages.reduce((total, page) => total + page.blocks.length, 0),
    actions: snapshot.pages.reduce((total, page) => total + page.actions.length, 0),
  };
  return LiveExtractionArtifactSchema.parse({
    schemaVersion: 1,
    artifactKind: "live_sonnet_extraction",
    goal: LIVE_DEMO_GOAL,
    portalUrl: LIVE_DEMO_PORTAL_URL,
    sourceSnapshot: snapshot,
    procedureModel: model,
    evidence: validation.evidence,
    sourceSelection: {
      sourceSnapshotId: snapshot.id,
      sourceSnapshotHash: snapshot.contentHash,
      userGoal: LIVE_DEMO_GOAL,
      selectionMode: "goal_scoped",
      semanticCoverage: "not_verified",
      coverage: "complete",
      limitations: [],
      originalCounts: counts,
      selectedCounts: counts,
      selectedPageIds: snapshot.pages.map((page) => page.id),
    },
    semanticAudit,
    provenance: {
      extractionType: "live",
      modelName: "claude-sonnet-test",
      completedAt,
    },
  });
}

function recordedLiveArtifact(): LiveExtractionArtifact {
  const bundle = recordedExtractionBundle;
  return LiveExtractionArtifactSchema.parse({
    schemaVersion: 1,
    artifactKind: "live_sonnet_extraction",
    goal: LIVE_DEMO_GOAL,
    portalUrl: LIVE_DEMO_PORTAL_URL,
    sourceSnapshot: bundle.sourceSnapshot,
    procedureModel: bundle.procedureModel,
    evidence: bundle.buildTimeEvidence,
    sourceSelection: {
      sourceSnapshotId: bundle.sourceSnapshot.id,
      sourceSnapshotHash: bundle.sourceSnapshot.contentHash,
      userGoal: LIVE_DEMO_GOAL,
      selectionMode: "goal_scoped",
      semanticCoverage: "not_verified",
      coverage: "complete",
      limitations: [],
      originalCounts: bundle.sourceSelection.originalCounts,
      selectedCounts: bundle.sourceSelection.selectedCounts,
      selectedPageIds: bundle.sourceSelection.selectedPageIds,
    },
    semanticAudit: bundle.semanticAudit,
    provenance: {
      extractionType: "live",
      modelName: bundle.provenance.modelName,
      completedAt,
    },
  });
}

function startResponse(responseJobId: string = jobId) {
  return {
    schemaVersion: 1,
    jobId: responseJobId,
    state: "queued",
    statusUrl: `/api/live-extraction/jobs/${responseJobId}`,
    pollAfterMs: 1_000,
  };
}

function status(
  state:
    | "queued"
    | "collecting"
    | "selecting_sources"
    | "extracting_policy"
    | "mapping_procedure"
    | "validating",
) {
  if (state === "queued") {
    return {
      schemaVersion: 1,
      jobId,
      requestId,
      state: "queued",
      phase: "queued",
      createdAt,
      updatedAt: createdAt,
    };
  }
  return {
    schemaVersion: 1,
    jobId,
    requestId,
    state: "running",
    phase: state,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
  };
}

function succeeded(
  artifact: LiveExtractionArtifact,
  identity: Readonly<{ jobId: string; requestId: string }> = { jobId, requestId },
) {
  return {
    schemaVersion: 1,
    jobId: identity.jobId,
    requestId: identity.requestId,
    state: "succeeded",
    phase: "complete",
    createdAt,
    updatedAt: completedAt,
    startedAt: createdAt,
    completedAt,
    expiresAt,
    result: artifact,
  };
}

function failed(code: "PORTAL_UNAVAILABLE" | "STAGE_2_RESPONSE_INVALID") {
  return {
    schemaVersion: 1,
    jobId,
    requestId,
    state: "failed",
    phase: "failed",
    createdAt,
    updatedAt: completedAt,
    startedAt: createdAt,
    completedAt,
    expiresAt,
    error: {
      code,
      stage: code === "PORTAL_UNAVAILABLE" ? "collector" : "procedure_mapping",
      message:
        code === "PORTAL_UNAVAILABLE"
          ? "The controlled portal could not be reached."
          : "Procedure mapping returned an invalid structured response.",
      retryable: code === "PORTAL_UNAVAILABLE",
      issueCodes: [],
    },
  };
}

function jsonResponse(body: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json" },
  });
}

function providerFor(
  responses: readonly Readonly<{ body: unknown; status?: number }>[],
) {
  const queue = [...responses];
  const fetch = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      const next = queue.shift();
      if (next === undefined) throw new Error("Unexpected test fetch");
      return jsonResponse(next.body, next.status ?? 200);
    },
  );
  const waits: number[] = [];
  const provider = new LiveExtractionProvider({
    fetch,
    generateRequestId: () => requestId,
    now: fixedNow,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });
  return { provider, fetch, waits };
}

function request(userState = scheduledStandardState) {
  return {
    goal: LIVE_DEMO_GOAL,
    portalUrl: LIVE_DEMO_PORTAL_URL,
    scenarioId: "dynamic-replanning" as const,
    userState,
  };
}

describe("LiveExtractionProvider", () => {
  it("posts once, polls non-overlapping one-second phases, and evaluates the verified result", async () => {
    const artifact = demoLiveArtifact();
    const phases: string[] = [];
    const { provider, fetch, waits } = providerFor([
      { body: startResponse(), status: 202 },
      { body: status("queued") },
      { body: status("collecting") },
      { body: status("selecting_sources") },
      { body: status("extracting_policy") },
      { body: status("mapping_procedure") },
      { body: status("validating") },
      { body: succeeded(artifact) },
    ]);

    const analysis = await provider.analyze(request(), {
      onProgress: (progress) => phases.push(progress.phase),
    });

    expect(fetch).toHaveBeenCalledTimes(8);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(waits).toEqual(Array(7).fill(1_000));
    expect(phases).toEqual([
      "queued",
      "queued",
      "queued",
      "collecting",
      "selecting_sources",
      "extracting_policy",
      "mapping_procedure",
      "validating",
      "complete",
    ]);
    expect(analysis).toMatchObject({
      mode: "live_sonnet",
      plan: { status: "ready" },
      source: {
        label: "Live Sonnet extraction",
        extractionPreviouslyCompleted: false,
      },
    });
    expect(analysis.plan.steps.every((step) => step.autoExecutable === false)).toBe(true);
  });

  it("deduplicates simultaneous submissions into one paid job", async () => {
    const { provider, fetch } = providerFor([
      { body: startResponse(), status: 202 },
      { body: succeeded(demoLiveArtifact()) },
    ]);

    const first = provider.analyze(request());
    const duplicate = provider.analyze(request());

    expect(duplicate).toBe(first);
    await expect(first).resolves.toMatchObject({ mode: "live_sonnet" });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("retains only the latest successful live session", async () => {
    const nextRequestId = "request_cccccccccccccccccccccccccccccccc" as const;
    const nextJobId = "job_dddddddddddddddddddddddddddddddd" as const;
    const responses = [
      jsonResponse(startResponse(), 202),
      jsonResponse(succeeded(demoLiveArtifact())),
      jsonResponse(startResponse(nextJobId), 202),
      jsonResponse(
        succeeded(demoLiveArtifact(), {
          jobId: nextJobId,
          requestId: nextRequestId,
        }),
      ),
    ];
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected test fetch");
        return response;
      },
    );
    const requestIds = [requestId, nextRequestId];
    const provider = new LiveExtractionProvider({
      fetch,
      generateRequestId: () => {
        const next = requestIds.shift();
        if (next === undefined) throw new Error("Unexpected request ID generation");
        return next;
      },
      now: fixedNow,
      wait: async () => {},
    });

    const first = await provider.analyze(request());
    const second = await provider.analyze(request());

    expect(second.sessionId).not.toBe(first.sessionId);
    await expect(provider.getEvidence(second.sessionId)).resolves.toEqual(second.evidence);
    await expect(
      provider.replan(second.sessionId, scheduledInstantState),
    ).resolves.toMatchObject({ sessionId: second.sessionId });
    await expect(provider.getEvidence(first.sessionId)).rejects.toMatchObject({
      code: "SESSION_MISSING",
    });
    await expect(
      provider.replan(first.sessionId, scheduledInstantState),
    ).rejects.toMatchObject({ code: "SESSION_MISSING" });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });

  it("rejects malformed start and polling responses", async () => {
    const malformedStart = providerFor([
      { body: { schemaVersion: 1, state: "queued" }, status: 202 },
    ]).provider;
    await expect(malformedStart.analyze(request())).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });

    const malformedPoll = providerFor([
      { body: startResponse(), status: 202 },
      { body: { schemaVersion: 1, jobId, state: "succeeded" } },
    ]).provider;
    await expect(malformedPoll.analyze(request())).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
  });

  it("fails closed when backend success contains a different evidence disposition", async () => {
    const artifact = structuredClone(demoLiveArtifact());
    artifact.evidence.validRuleIds = [];
    const { provider } = providerFor([
      { body: startResponse(), status: 202 },
      { body: succeeded(artifact) },
    ]);

    await expect(provider.analyze(request())).rejects.toMatchObject({
      code: "EVIDENCE_RESULT_MISMATCH",
    });
  });

  it("rejects a snapshot whose bound hash is not its recomputed content hash", () => {
    const artifact = structuredClone(demoLiveArtifact());
    const badHash = "f".repeat(64);
    artifact.sourceSnapshot.contentHash = badHash;
    artifact.procedureModel.sourceSnapshotHash = badHash;
    artifact.evidence.snapshotHash = badHash;
    artifact.sourceSelection.sourceSnapshotHash = badHash;

    expect(() => verifyLiveExtractionArtifact(artifact)).toThrowError(
      expect.objectContaining({
        code: "SNAPSHOT_HASH_MISMATCH",
      }),
    );
  });

  it("fails closed for every browser-side artifact-integrity boundary", () => {
    const cases: readonly Readonly<{
      name: string;
      code:
        | "ARTIFACT_SCHEMA_INVALID"
        | "BLOCK_HASH_MISMATCH"
        | "ACTION_FINGERPRINT_MISMATCH"
        | "PAGE_HASH_MISMATCH"
        | "SEMANTIC_AUDIT_MISMATCH";
      mutate: (artifact: LiveExtractionArtifact) => unknown;
    }>[] = [
      {
        name: "evidence block hash",
        code: "BLOCK_HASH_MISMATCH",
        mutate: (artifact) => {
          const block = artifact.sourceSnapshot.pages[0]?.blocks[0];
          if (block === undefined) throw new Error("Test block is unavailable");
          block.textHash = "0".repeat(64);
          return artifact;
        },
      },
      {
        name: "website action fingerprint",
        code: "ACTION_FINGERPRINT_MISMATCH",
        mutate: (artifact) => {
          const action = artifact.sourceSnapshot.pages[0]?.actions[0];
          if (action === undefined) throw new Error("Test action is unavailable");
          action.fingerprint = "0".repeat(64);
          return artifact;
        },
      },
      {
        name: "page content hash",
        code: "PAGE_HASH_MISMATCH",
        mutate: (artifact) => {
          const page = artifact.sourceSnapshot.pages[0];
          if (page === undefined) throw new Error("Test page is unavailable");
          page.contentHash = "0".repeat(64);
          return artifact;
        },
      },
      {
        name: "model snapshot binding",
        code: "ARTIFACT_SCHEMA_INVALID",
        mutate: (artifact) => {
          artifact.procedureModel.sourceSnapshotId = "snapshot_other01";
          return artifact;
        },
      },
      {
        name: "semantic audit",
        code: "SEMANTIC_AUDIT_MISMATCH",
        mutate: (artifact) => {
          const rule = artifact.procedureModel.rules[0];
          const citation = rule?.citations[0];
          if (rule === undefined || citation === undefined) {
            throw new Error("Test citation is unavailable");
          }
          artifact.semanticAudit.findings.push({
            ruleId: rule.id,
            code: "QUALIFIER_UNCERTAIN",
            message: "Injected audit mismatch.",
            pageId: citation.pageId,
            blockId: citation.blockId,
            excerpt: citation.excerpt,
          });
          artifact.semanticAudit.reviewRequiredRuleIds = [rule.id];
          return artifact;
        },
      },
      {
        name: "strict unknown field",
        code: "ARTIFACT_SCHEMA_INVALID",
        mutate: (artifact) => ({ ...artifact, unexpected: true }),
      },
    ];

    for (const testCase of cases) {
      const input = testCase.mutate(structuredClone(demoLiveArtifact()));
      expect(
        () => verifyLiveExtractionArtifact(input),
        testCase.name,
      ).toThrowError(expect.objectContaining({ code: testCase.code }));
    }
  });

  it("preserves semantic review as a successful extraction outcome", async () => {
    const { provider } = providerFor([
      { body: startResponse(), status: 202 },
      { body: succeeded(recordedLiveArtifact()) },
    ]);

    const analysis = await provider.analyze(
      request(recordedExtractionBundle.defaultScenario.userState),
    );

    expect(analysis.evidence.status).toBe("degraded");
    expect(analysis.plan.status).toBe("review_required");
    expect(analysis.semanticAuditFindings).not.toHaveLength(0);
    expect(analysis.evidence.issues.map((issue) => issue.code)).toContain(
      "SEMANTIC_REVIEW_REQUIRED",
    );
  });

  it("keeps active prohibitions authoritative while allowing a correctly qualified Standard route", async () => {
    const { provider, fetch } = providerFor([
      { body: startResponse(), status: 202 },
      { body: succeeded(demoLiveArtifact()) },
    ]);
    const standard = await provider.analyze(request(scheduledStandardState));
    const instantState = UserStateSchema.parse({
      ...scheduledInstantState,
      revision: standard.plan.userStateRevision + 1,
    });
    const instant = await provider.replan(standard.sessionId, instantState);
    const cancelDecision = instant.evaluation.decisions.find(
      (decision) => decision.actionId === "proc_cancel01",
    );

    expect(standard.plan).toMatchObject({ status: "ready" });
    expect(standard.evidence.validRuleIds).toContain("rule_cancelpermit1");
    expect(
      standard.semanticAuditFindings.some(
        (finding) => finding.ruleId === "rule_cancelpermit1",
      ),
    ).toBe(false);
    expect(standard.plan.steps.map((step) => step.procedureActionId)).toContain(
      "proc_cancel01",
    );
    expect(instant.evidence.validRuleIds).toContain("rule_instantdeny1");
    expect(cancelDecision).toMatchObject({
      status: "forbidden",
      reasonCodes: ["PROHIBITED"],
    });
    expect(instant.plan.steps.map((step) => step.procedureActionId)).not.toContain(
      "proc_cancel01",
    );
    expect(instant.plan.steps.every((step) => step.autoExecutable === false)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports API contention, portal failure, transport failure, and malformed JSON distinctly", async () => {
    const contention = providerFor([
      {
        status: 409,
        body: {
          schemaVersion: 1,
          error: {
            code: "JOB_ALREADY_RUNNING",
            stage: "job",
            message: "Another extraction is already running.",
            retryable: true,
            issueCodes: [],
          },
        },
      },
    ]).provider;
    await expect(contention.analyze(request())).rejects.toMatchObject({
      code: "JOB_ALREADY_RUNNING",
    });
    expect(contention.resumeState()).toBe("none");

    const portal = providerFor([
      { body: startResponse(), status: 202 },
      { body: failed("PORTAL_UNAVAILABLE") },
    ]).provider;
    const failurePhases: string[] = [];
    await expect(portal.analyze(request(), {
      onProgress: (progress) => failurePhases.push(progress.phase),
    })).rejects.toMatchObject({
      code: "PORTAL_UNAVAILABLE",
    });
    expect(failurePhases.at(-1)).toBe("failed");
    expect(portal.resumeState()).toBe("none");

    const transport = new LiveExtractionProvider({
      fetch: async () => {
        throw new TypeError("connection refused");
      },
      generateRequestId: () => requestId,
    });
    await expect(transport.analyze(request())).rejects.toMatchObject({
      code: "TRANSPORT_ERROR",
    });
    expect(transport.resumeState()).toBe("request");

    const ambiguousInternal = providerFor([
      {
        status: 500,
        body: {
          schemaVersion: 1,
          error: {
            code: "INTERNAL_ERROR",
            stage: "internal",
            message: "The server could not publish the extraction state.",
            retryable: true,
            issueCodes: [],
          },
        },
      },
    ]).provider;
    await expect(ambiguousInternal.analyze(request())).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    expect(ambiguousInternal.resumeState()).toBe("request");

    const malformedJson = new LiveExtractionProvider({
      fetch: async () => new Response("{", { status: 202 }),
      generateRequestId: () => requestId,
    });
    await expect(malformedJson.analyze(request())).rejects.toMatchObject({
      code: "MALFORMED_RESPONSE",
    });
  });

  it("uses a new request ID after a definitive start rejection", async () => {
    const nextRequestId = "request_cccccccccccccccccccccccccccccccc" as const;
    const responses = [
      jsonResponse({
        schemaVersion: 1,
        error: {
          code: "JOB_ALREADY_RUNNING",
          stage: "job",
          message: "Another extraction is already running.",
          retryable: true,
          issueCodes: [],
        },
      }, 409),
      jsonResponse(startResponse(), 202),
      jsonResponse({ ...succeeded(demoLiveArtifact()), requestId: nextRequestId }),
    ];
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected test fetch");
        return response;
      },
    );
    const requestIds = [requestId, nextRequestId];
    const provider = new LiveExtractionProvider({
      fetch,
      generateRequestId: () => {
        const next = requestIds.shift();
        if (next === undefined) throw new Error("Unexpected request ID generation");
        return next;
      },
      now: fixedNow,
      wait: async () => {},
    });

    await expect(provider.analyze(request())).rejects.toMatchObject({
      code: "JOB_ALREADY_RUNNING",
    });
    await expect(provider.analyze(request())).resolves.toMatchObject({
      mode: "live_sonnet",
    });
    const postedRequestIds = fetch.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => {
        if (typeof init?.body !== "string") throw new Error("POST body is unavailable");
        return LiveExtractionStartRequestSchema.parse(JSON.parse(init.body));
      });
    expect(postedRequestIds).toEqual([
      expect.objectContaining({ requestId }),
      expect.objectContaining({ requestId: nextRequestId }),
    ]);
  });

  it("clears a previous Live ready plan when a newer extraction fails", async () => {
    const { provider } = providerFor([
      { body: startResponse(), status: 202 },
      { body: succeeded(demoLiveArtifact()) },
    ]);
    const analysis = await provider.analyze(request());
    const completed = applyAnalysisResult(
      createModeWorkspaceState("live_sonnet"),
      "live_sonnet",
      analysis,
      "analysis",
    );
    const failedState = failModeAnalysis(
      completed,
      "live_sonnet",
      "The controlled portal is unavailable.",
    );

    expect(completed.analysis?.plan.status).toBe("ready");
    expect(failedState).toMatchObject({
      analysis: null,
      originalAnalysis: null,
      isDirty: false,
      error: "The controlled portal is unavailable.",
    });
  });

  it("discards missing or expired job identities so an explicit retry can start fresh", async () => {
    const expired = {
      schemaVersion: 1,
      error: {
        code: "JOB_EXPIRED",
        stage: "job",
        message: "The retained live extraction result expired.",
        retryable: true,
        issueCodes: [],
      },
    };
    const { provider, fetch } = providerFor([
      { body: startResponse(), status: 202 },
      { body: expired, status: 410 },
      { body: startResponse(), status: 202 },
      { body: succeeded(demoLiveArtifact()) },
    ]);

    await expect(provider.analyze(request())).rejects.toMatchObject({
      code: "JOB_EXPIRED",
    });
    expect(provider.canResume()).toBe(false);
    expect(provider.resumeState()).toBe("none");
    await expect(provider.analyze(request())).resolves.toMatchObject({
      mode: "live_sonnet",
    });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
  });

  it("stops stale polling locally and resumes the retained job without another POST", async () => {
    let releaseStalePoll: ((response: Response) => void) | undefined;
    let call = 0;
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        call += 1;
        if (call === 1) return jsonResponse(startResponse(), 202);
        if (call === 2) {
          return await new Promise<Response>((resolve) => {
            releaseStalePoll = resolve;
          });
        }
        return jsonResponse(succeeded(demoLiveArtifact()));
      },
    );
    const provider = new LiveExtractionProvider({
      fetch,
      generateRequestId: () => requestId,
      now: fixedNow,
      wait: async () => {},
    });

    const stale = provider.analyze(request());
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    provider.stop("mode_changed");
    const resumed = provider.analyze(request());
    expect(provider.canResume()).toBe(true);
    expect(provider.resumeState()).toBe("job");
    expect(fetch).toHaveBeenCalledTimes(2);
    releaseStalePoll?.(jsonResponse(succeeded(demoLiveArtifact())));

    await expect(stale).rejects.toMatchObject({ code: "CLIENT_STOPPED" });
    await expect(resumed).resolves.toMatchObject({ mode: "live_sonnet" });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("honors a stop while an HTTP error body is still being parsed", async () => {
    let releaseBody:
      | ((body: {
          schemaVersion: number;
          error: {
            code: string;
            stage: string;
            message: string;
            retryable: boolean;
            issueCodes: never[];
          };
        }) => void)
      | undefined;
    const expired = {
      schemaVersion: 1,
      error: {
        code: "JOB_EXPIRED",
        stage: "job",
        message: "The retained live extraction result expired.",
        retryable: true,
        issueCodes: [],
      },
    };
    const delayedError = jsonResponse(expired, 410);
    const json = vi.spyOn(delayedError, "json").mockImplementation(
      async () =>
        await new Promise((resolve) => {
          releaseBody = resolve;
        }),
    );
    let call = 0;
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
        call += 1;
        if (call === 1) return jsonResponse(startResponse(), 202);
        if (call === 2) return delayedError;
        return jsonResponse(succeeded(demoLiveArtifact()));
      },
    );
    const provider = new LiveExtractionProvider({
      fetch,
      generateRequestId: () => requestId,
      now: fixedNow,
      wait: async () => {},
    });

    const stale = provider.analyze(request());
    await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
    provider.stop("mode_changed");
    const resumed = provider.analyze(request());
    releaseBody?.(expired);

    await expect(stale).rejects.toMatchObject({ code: "CLIENT_STOPPED" });
    await expect(resumed).resolves.toMatchObject({ mode: "live_sonnet" });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});

describe("live artifact verifier", () => {
  it("uses the canonical helper pipeline and typed integrity errors", () => {
    const verified = verifyLiveExtractionArtifact(demoLiveArtifact());
    expect(verified.evidence).toEqual(verified.artifact.evidence);

    const malformed = { schemaVersion: 1 };
    expect(() => verifyLiveExtractionArtifact(malformed)).toThrow(
      LiveArtifactIntegrityError,
    );
    expect(() => verifyLiveExtractionArtifact(malformed)).toThrowError(
      expect.objectContaining({ code: "ARTIFACT_SCHEMA_INVALID" }),
    );
  });

  it("exposes typed client failures without raw provider payloads", () => {
    const error = new LiveExtractionClientError(
      "STAGE_2_RESPONSE_INVALID",
      "Procedure mapping returned an invalid structured response.",
    );
    expect(error).toMatchObject({
      code: "STAGE_2_RESPONSE_INVALID",
      name: "LiveExtractionClientError",
    });
  });
});
