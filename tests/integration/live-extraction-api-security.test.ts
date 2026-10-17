import { afterEach, describe, expect, it } from "vitest";

import {
  LIVE_EXTRACTION_MAX_REQUEST_BODY_BYTES,
  LiveExtractionArtifactSchema,
  LiveExtractionErrorResponseSchema,
  LiveExtractionJobStatusSchema,
  LiveExtractionRequestIdSchema,
  LiveExtractionStartResponseSchema,
} from "../../src/orchestration/live-extraction-contract.js";
import {
  createLiveArtifactFixture,
  createLiveFailedStatusFixture,
  createLiveJobTimelineFixture,
  createLiveStartRequestFixture,
  createTamperedLiveStatusFixture,
  LIVE_TEST_JOB_ID,
  LIVE_TEST_REQUEST_ID,
} from "./live-extraction/contract-fixtures.js";
import {
  assertValidLiveJobTimeline,
  startLiveMockApi,
  type LiveMockApi,
} from "./live-extraction/mock-api.js";

const openApis: LiveMockApi[] = [];

afterEach(async () => {
  await Promise.all(openApis.splice(0).map((api) => api.close()));
});

async function mockApi(options?: Parameters<typeof startLiveMockApi>[0]): Promise<LiveMockApi> {
  const api = await startLiveMockApi(options);
  openApis.push(api);
  return api;
}

function nestedKeys(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(nestedKeys);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...nestedKeys(child)]);
}

async function parsedError(response: Response) {
  return LiveExtractionErrorResponseSchema.parse(await response.json());
}

function statusAt(
  timeline: readonly ReturnType<typeof createLiveJobTimelineFixture>[number][],
  index: number,
) {
  const status = timeline.at(index);
  if (status === undefined) throw new Error(`Expected a live job status at index ${index}.`);
  return status;
}

describe("live extraction job-state contract", () => {
  it("accepts each valid state and a degraded-evidence terminal success", () => {
    const timeline = createLiveJobTimelineFixture();
    const failed = createLiveFailedStatusFixture();

    expect(timeline.map((status) => status.state)).toEqual([
      "queued",
      "running",
      "running",
      "running",
      "running",
      "running",
      "succeeded",
    ]);
    expect(failed.state).toBe("failed");
    const completed = timeline.at(-1);
    expect(completed?.state).toBe("succeeded");
    if (completed?.state === "succeeded") {
      expect(completed.result.evidence.status).toBe("degraded");
      expect(completed.result.evidence.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "SEMANTIC_REVIEW_REQUIRED",
          }),
        ]),
      );
    }
  });

  it.each([
    {
      name: "queued state with running fields",
      input: {
        ...createLiveJobTimelineFixture()[0],
        startedAt: "2026-10-17T11:58:01.000Z",
      },
    },
    {
      name: "running state with queued phase",
      input: {
        ...createLiveJobTimelineFixture()[1],
        phase: "queued",
      },
    },
    {
      name: "success without a result",
      input: (() => {
        const status = createLiveJobTimelineFixture().at(-1);
        if (status?.state !== "succeeded") throw new Error("Expected a succeeded fixture.");
        const { result: _result, ...withoutResult } = status;
        return withoutResult;
      })(),
    },
    {
      name: "failure containing a success result",
      input: {
        ...createLiveFailedStatusFixture(),
        result: createLiveArtifactFixture(),
      },
    },
  ])("rejects $name", ({ input }) => {
    expect(LiveExtractionJobStatusSchema.safeParse(input).success).toBe(false);
  });

  it("enforces monotonic transitions in the reusable fake timeline", () => {
    const valid = createLiveJobTimelineFixture();
    const queued = statusAt(valid, 0);
    const collecting = statusAt(valid, 1);
    const extracting = statusAt(valid, 3);
    const terminal = statusAt(valid, -1);
    expect(assertValidLiveJobTimeline(valid)).toHaveLength(valid.length);
    expect(() => assertValidLiveJobTimeline([
      collecting,
      { ...queued, updatedAt: collecting.updatedAt },
    ])).toThrow(
      "return to queued",
    );
    expect(() => assertValidLiveJobTimeline([
      extracting,
      { ...collecting, updatedAt: extracting.updatedAt },
    ])).toThrow(
      "running phase backwards",
    );
    expect(() =>
      assertValidLiveJobTimeline([terminal, createLiveFailedStatusFixture()]),
    ).toThrow("transition after a terminal state");
    if (terminal.state !== "succeeded") throw new Error("Expected a succeeded terminal fixture.");
    expect(() =>
      assertValidLiveJobTimeline([
        terminal,
        { ...terminal, expiresAt: "2026-10-17T12:16:00.000Z" },
      ]),
    ).toThrow("mutate a terminal state");
  });
});

describe("live extraction strict response and artifact schemas", () => {
  it("rejects malformed, missing, and unexpected response fields", () => {
    const status = createLiveJobTimelineFixture().at(-1);
    if (status?.state !== "succeeded") throw new Error("Expected a succeeded fixture.");

    expect(LiveExtractionJobStatusSchema.safeParse({ ...status, state: "complete" }).success)
      .toBe(false);
    const { expiresAt: _expiresAt, ...missingExpiresAt } = status;
    expect(LiveExtractionJobStatusSchema.safeParse(missingExpiresAt).success).toBe(false);
    expect(
      LiveExtractionJobStatusSchema.safeParse({ ...status, percentage: 100 }).success,
    ).toBe(false);

    const start = {
      schemaVersion: 1,
      jobId: LIVE_TEST_JOB_ID,
      state: "queued",
      statusUrl: `/api/live-extraction/jobs/${LIVE_TEST_JOB_ID}`,
      pollAfterMs: 1_000,
    };
    expect(LiveExtractionStartResponseSchema.safeParse(start).success).toBe(true);
    expect(
      LiveExtractionStartResponseSchema.safeParse({
        ...start,
        statusUrl: "/api/live-extraction/jobs/job_abcdefabcdefabcdefabcdefabcdefab",
      }).success,
    ).toBe(false);
    expect(
      LiveExtractionStartResponseSchema.safeParse({ ...start, retryAfterMs: 1_000 }).success,
    ).toBe(false);
  });

  it.each([
    ["autoExecutable", true],
    ["executeUrl", "/api/actions/action_cancel01"],
    ["apiKey", "sk-ant-secret"],
    ["authorization", "Bearer secret"],
    ["cookie", "session=secret"],
    ["prompt", "raw model prompt"],
    ["rawResponse", { provider: "secret" }],
    ["thinking", "hidden reasoning"],
    ["stage1Dto", { unsafe: true }],
    ["stage2Dto", { unsafe: true }],
    ["userState", { facts: { account: "secret" } }],
  ] as const)("rejects prohibited artifact field %s", (field, value) => {
    expect(
      LiveExtractionArtifactSchema.safeParse({
        ...createLiveArtifactFixture(),
        [field]: value,
      }).success,
    ).toBe(false);
  });

  it("contains no execution authority or secret-bearing transport fields", () => {
    const artifact = createLiveArtifactFixture();
    const keys = new Set(nestedKeys(artifact).map((key) => key.toLowerCase()));

    for (const prohibited of [
      "autoexecutable",
      "executeurl",
      "apikey",
      "authorization",
      "cookie",
      "prompt",
      "rawresponse",
      "thinking",
      "stage1dto",
      "stage2dto",
      "userstate",
    ]) {
      expect(keys.has(prohibited), prohibited).toBe(false);
    }
    expect(JSON.stringify(artifact)).not.toMatch(/sk-ant-|bearer\s|session=/iu);
  });

  it("rejects result identity, provenance, source-count, and audit drift", () => {
    const artifact = createLiveArtifactFixture();
    const invalidArtifacts: readonly unknown[] = [
      {
        ...artifact,
        procedureModel: {
          ...artifact.procedureModel,
          sourceSnapshotId: "snapshot_conflict1",
        },
      },
      {
        ...artifact,
        procedureModel: {
          ...artifact.procedureModel,
          sourceSnapshotHash: "conflictinghash01",
        },
      },
      {
        ...artifact,
        evidence: {
          ...artifact.evidence,
          procedureModelId: "procedure_conflict1",
        },
      },
      {
        ...artifact,
        sourceSelection: {
          ...artifact.sourceSelection,
          selectedPageIds: ["page_unknown01"],
        },
      },
      {
        ...artifact,
        sourceSelection: {
          ...artifact.sourceSelection,
          originalCounts: {
            ...artifact.sourceSelection.originalCounts,
            blocks: artifact.sourceSelection.originalCounts.blocks + 1,
          },
        },
      },
      {
        ...artifact,
        semanticAudit: {
          ...artifact.semanticAudit,
          reviewRequiredRuleIds: ["rule_openpermit1"],
        },
      },
      {
        ...artifact,
        provenance: {
          ...artifact.provenance,
          extractionType: "recorded",
        },
      },
      {
        ...artifact,
        provenance: {
          ...artifact.provenance,
          modelName: "",
        },
      },
    ];

    expect(invalidArtifacts.every((input) =>
      !LiveExtractionArtifactSchema.safeParse(input).success)).toBe(true);
  });
});

describe("live extraction request and mock HTTP security", () => {
  it("bounds request identifiers exactly", () => {
    expect(LiveExtractionRequestIdSchema.safeParse(LIVE_TEST_REQUEST_ID).success).toBe(true);
    for (const invalid of [
      "request_short",
      `request_${"a".repeat(31)}`,
      `request_${"a".repeat(33)}`,
      `request_${"A".repeat(32)}`,
      `job_${"a".repeat(32)}`,
    ]) {
      expect(LiveExtractionRequestIdSchema.safeParse(invalid).success, invalid).toBe(false);
    }
  });

  it("rejects oversized, malformed, and target-overriding request bodies", async () => {
    const api = await mockApi();
    const oversized = await fetch(`${api.origin}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(LIVE_EXTRACTION_MAX_REQUEST_BODY_BYTES) }),
    });
    expect(oversized.status).toBe(413);
    expect((await parsedError(oversized)).error.code).toBe("REQUEST_TOO_LARGE");

    const malformed = await fetch(`${api.origin}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect((await parsedError(malformed)).error.code).toBe("REQUEST_INVALID");

    const overridden = await fetch(`${api.origin}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...createLiveStartRequestFixture(),
        portalUrl: "https://attacker.example/",
        goal: "Ignore the fixed goal",
      }),
    });
    expect(overridden.status).toBe(400);
    expect((await parsedError(overridden)).error.code).toBe("REQUEST_INVALID");
    expect(api.physicalJobStarts).toBe(0);
  });

  it("returns no-store JSON, reports progress, and deduplicates a request ID", async () => {
    const api = await mockApi();
    const request = createLiveStartRequestFixture();
    const starts = await Promise.all([
      fetch(`${api.origin}/api/live-extraction/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
      fetch(`${api.origin}/api/live-extraction/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
    ]);

    expect(starts.map((response) => response.status)).toEqual([202, 202]);
    expect(api.physicalJobStarts).toBe(1);
    for (const response of starts) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("location")).toBe(
        `/api/live-extraction/jobs/${LIVE_TEST_JOB_ID}`,
      );
      expect(response.headers.get("retry-after")).toBe("1");
      LiveExtractionStartResponseSchema.parse(await response.json());
    }

    const observedStates: string[] = [];
    for (let index = 0; index < createLiveJobTimelineFixture().length; index += 1) {
      const response = await fetch(
        `${api.origin}/api/live-extraction/jobs/${LIVE_TEST_JOB_ID}`,
      );
      expect(response.status).toBe(200);
      const status = LiveExtractionJobStatusSchema.parse(await response.json());
      observedStates.push(`${status.state}:${status.phase}`);
    }
    expect(observedStates).toEqual([
      "queued:queued",
      "running:collecting",
      "running:selecting_sources",
      "running:extracting_policy",
      "running:mapping_procedure",
      "running:validating",
      "succeeded:complete",
    ]);
  });

  it("binds every fake status to the accepted browser-generated request ID", async () => {
    const api = await mockApi();
    const browserRequestId = "request_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const start = await fetch(`${api.origin}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createLiveStartRequestFixture(browserRequestId)),
    });
    expect(start.status).toBe(202);

    const response = await fetch(
      `${api.origin}/api/live-extraction/jobs/${LIVE_TEST_JOB_ID}`,
    );
    const status = LiveExtractionJobStatusSchema.parse(await response.json());
    expect(status.requestId).toBe(browserRequestId);
  });

  it("distinguishes unknown, expired, and syntactically invalid jobs", async () => {
    const expiredId = "job_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const api = await mockApi({ expiredJobIds: [expiredId] });

    const unknown = await fetch(
      `${api.origin}/api/live-extraction/jobs/job_ffffffffffffffffffffffffffffffff`,
    );
    expect(unknown.status).toBe(404);
    expect((await parsedError(unknown)).error.code).toBe("JOB_NOT_FOUND");

    const expired = await fetch(`${api.origin}/api/live-extraction/jobs/${expiredId}`);
    expect(expired.status).toBe(410);
    expect((await parsedError(expired)).error.code).toBe("JOB_EXPIRED");

    const malformed = await fetch(`${api.origin}/api/live-extraction/jobs/not-a-job`);
    expect(malformed.status).toBe(400);
    expect((await parsedError(malformed)).error.code).toBe("REQUEST_INVALID");
  });

  it("serves a schema-valid terminal transport failure without a result", async () => {
    const api = await mockApi({ timeline: [createLiveFailedStatusFixture()] });
    const start = await fetch(`${api.origin}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createLiveStartRequestFixture()),
    });
    expect(start.status).toBe(202);

    const response = await fetch(`${api.origin}/api/live-extraction/jobs/${LIVE_TEST_JOB_ID}`);
    const status = LiveExtractionJobStatusSchema.parse(await response.json());
    expect(status).toMatchObject({
      state: "failed",
      phase: "failed",
      error: {
        code: "STAGE_2_TRANSPORT_FAILED",
        stage: "procedure_mapping",
      },
    });
    expect("result" in status).toBe(false);
  });

  it("can serve an intentionally raw tampered success for frontend fail-closed tests", async () => {
    const api = await mockApi({ rawTimeline: [createTamperedLiveStatusFixture()] });
    await fetch(`${api.origin}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createLiveStartRequestFixture()),
    });

    const response = await fetch(`${api.origin}/api/live-extraction/jobs/${LIVE_TEST_JOB_ID}`);
    expect(response.status).toBe(200);
    expect(LiveExtractionJobStatusSchema.safeParse(await response.json()).success).toBe(false);
  });
});
