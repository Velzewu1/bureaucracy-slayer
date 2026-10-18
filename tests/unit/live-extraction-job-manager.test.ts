import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LIVE_EXTRACTION_JOB_TIMEOUT_MS,
  LIVE_EXTRACTION_TERMINAL_RETENTION_MS,
  LiveExtractionArtifactSchema,
  type LiveExtractionJobId,
  type LiveExtractionRequestId,
} from "../../src/orchestration/live-extraction-contract.js";
import {
  LiveExtractionJobManager,
  LiveExtractionPipelineError,
} from "../../src/orchestration/live-extraction-job-manager.js";
import {
  deferred,
  flushMicrotasks,
  liveExtractionArtifact,
} from "../live-extraction-test-helpers.js";

const REQUEST_1 = "request_11111111111111111111111111111111";
const REQUEST_2 = "request_22222222222222222222222222222222";
const REQUEST_3 = "request_33333333333333333333333333333333";
const REQUEST_4 = "request_44444444444444444444444444444444";

function jobIdGenerator(): () => LiveExtractionJobId {
  let next = 1;
  return () => {
    const suffix = next.toString(16).padStart(32, "0");
    next += 1;
    return `job_${suffix}`;
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("live extraction job manager", () => {
  it("binds retained jobs and tombstones to the normalized goal and trusted portal", async () => {
    const runner = vi.fn(() => Promise.resolve(liveExtractionArtifact()));
    const manager = new LiveExtractionJobManager({
      runner,
      portalIdentity: "http://127.0.0.1:5180/dashboard",
      createJobId: jobIdGenerator(),
      terminalResultLimit: 1,
    });
    const goal = "Can I recover money from a completed transfer?";
    const first = manager.start(REQUEST_1, `  ${goal}  `);
    const duplicate = manager.start(REQUEST_1, goal);
    const mismatch = manager.start(REQUEST_1, "What information is needed for recovery?");

    expect(first.ok).toBe(true);
    expect(duplicate).toMatchObject({
      ok: true,
      response: first.ok ? { jobId: first.response.jobId } : {},
    });
    expect(mismatch).toMatchObject({
      ok: false,
      failure: { code: "REQUEST_IDENTITY_MISMATCH", stage: "request" },
    });
    await flushMicrotasks();
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ goal }));

    const second = manager.start(REQUEST_2, goal);
    expect(second.ok).toBe(true);
    await flushMicrotasks();
    expect(manager.start(REQUEST_1, "A different goal")).toMatchObject({
      ok: false,
      failure: { code: "REQUEST_IDENTITY_MISMATCH" },
    });
  });

  it("deduplicates request IDs and admits only one physical worker", async () => {
    const pending = deferred<ReturnType<typeof liveExtractionArtifact>>();
    const runner = vi.fn(() => pending.promise);
    const manager = new LiveExtractionJobManager({
      runner,
      createJobId: jobIdGenerator(),
    });

    const first = manager.start(REQUEST_1);
    const duplicate = manager.start(REQUEST_1);
    const competing = manager.start(REQUEST_2);

    expect(first.ok).toBe(true);
    expect(duplicate.ok).toBe(true);
    if (first.ok && duplicate.ok) {
      expect(duplicate.response.jobId).toBe(first.response.jobId);
    }
    expect(competing).toMatchObject({
      ok: false,
      failure: { code: "JOB_ALREADY_RUNNING" },
    });

    await flushMicrotasks();
    expect(runner).toHaveBeenCalledTimes(1);
    pending.resolve(liveExtractionArtifact());
    await flushMicrotasks();
  });

  it("marks the logical deadline without releasing a physically hanging worker", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-17T12:00:00.000Z"));
    const pending = deferred<ReturnType<typeof liveExtractionArtifact>>();
    const runner = vi.fn(() => pending.promise);
    const manager = new LiveExtractionJobManager({
      runner,
      createJobId: jobIdGenerator(),
    });
    const started = manager.start(REQUEST_1);
    if (!started.ok) throw new Error("Expected the first job to start.");
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(LIVE_EXTRACTION_JOB_TIMEOUT_MS);
    expect(manager.get(started.response.jobId)).toMatchObject({
      kind: "found",
      status: {
        state: "failed",
        error: { code: "JOB_TIMED_OUT", stage: "timeout" },
      },
    });
    expect(manager.start(REQUEST_2)).toMatchObject({
      ok: false,
      failure: { code: "JOB_ALREADY_RUNNING" },
    });

    pending.resolve(liveExtractionArtifact());
    await flushMicrotasks();
    expect(manager.get(started.response.jobId)).toMatchObject({
      kind: "found",
      status: { state: "failed", error: { code: "JOB_TIMED_OUT" } },
    });
    expect(manager.start(REQUEST_2).ok).toBe(true);
  });

  it("preserves typed stage failures without exposing their causes", async () => {
    const runner = vi.fn(() =>
      Promise.reject(
        new LiveExtractionPipelineError({
          code: "STAGE_2_RESPONSE_INVALID",
          stage: "procedure_mapping",
          message: "Procedure mapping returned an invalid structured response.",
          retryable: false,
          issueCodes: ["CLAUDE_RESPONSE_INVALID"],
        }),
      ),
    );
    const manager = new LiveExtractionJobManager({
      runner,
      createJobId: jobIdGenerator(),
    });
    const started = manager.start(REQUEST_1);
    if (!started.ok) throw new Error("Expected the failure job to start.");
    await flushMicrotasks();

    expect(manager.get(started.response.jobId)).toMatchObject({
      kind: "found",
      status: {
        state: "failed",
        error: {
          code: "STAGE_2_RESPONSE_INVALID",
          stage: "procedure_mapping",
          issueCodes: ["CLAUDE_RESPONSE_INVALID"],
        },
      },
    });
  });

  it("caps complete terminal results and retains bounded expiration tombstones", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-17T12:00:00.000Z"));
    const runner = vi.fn(() => Promise.resolve(liveExtractionArtifact()));
    const manager = new LiveExtractionJobManager({
      runner,
      createJobId: jobIdGenerator(),
    });
    const requests: LiveExtractionRequestId[] = [REQUEST_1, REQUEST_2, REQUEST_3];
    const jobIds: LiveExtractionJobId[] = [];

    for (const requestId of requests) {
      const started = manager.start(requestId);
      if (!started.ok) throw new Error("Expected sequential terminal jobs to start.");
      jobIds.push(started.response.jobId);
      await flushMicrotasks();
    }

    const firstJobId = jobIds[0];
    if (firstJobId === undefined) throw new Error("Missing first generated job ID.");
    expect(manager.get(firstJobId)).toEqual({ kind: "expired" });
    const duplicate = manager.start(REQUEST_1);
    expect(duplicate).toMatchObject({
      ok: true,
      response: { jobId: firstJobId, state: "succeeded" },
    });
    expect(runner).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(LIVE_EXTRACTION_TERMINAL_RETENTION_MS + 1);
    expect(manager.get(firstJobId)).toEqual({ kind: "missing" });
    expect(manager.start(REQUEST_1).ok).toBe(true);
  });

  it("schedules idle artifact eviction and a fixed additional tombstone window", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-17T12:00:00.000Z"));
    const manager = new LiveExtractionJobManager({
      runner: () => Promise.resolve(liveExtractionArtifact()),
      createJobId: jobIdGenerator(),
    });
    const started = manager.start(REQUEST_1);
    if (!started.ok) throw new Error("Expected the retention job to start.");
    await flushMicrotasks();

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(LIVE_EXTRACTION_TERMINAL_RETENTION_MS);
    expect(vi.getTimerCount()).toBe(1);
    expect(manager.start(REQUEST_1)).toMatchObject({
      ok: true,
      response: { jobId: started.response.jobId, state: "succeeded" },
    });

    await vi.advanceTimersByTimeAsync(LIVE_EXTRACTION_TERMINAL_RETENTION_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(manager.get(started.response.jobId)).toEqual({ kind: "missing" });
  });

  it("removes the oldest tombstones when the tombstone bound is reached", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-17T12:00:00.000Z"));
    const manager = new LiveExtractionJobManager({
      runner: () => Promise.resolve(liveExtractionArtifact()),
      createJobId: jobIdGenerator(),
      terminalResultLimit: 1,
      tombstoneLimit: 2,
    });
    const jobIds: LiveExtractionJobId[] = [];
    for (const requestId of [REQUEST_1, REQUEST_2, REQUEST_3, REQUEST_4]) {
      const started = manager.start(requestId);
      if (!started.ok) throw new Error("Expected the bounded-retention job to start.");
      jobIds.push(started.response.jobId);
      await flushMicrotasks();
    }
    const [first, second, third, fourth] = jobIds;
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined
    ) {
      throw new Error("Expected four bounded-retention job IDs.");
    }

    expect(manager.get(first)).toEqual({ kind: "missing" });
    expect(manager.get(second)).toEqual({ kind: "expired" });
    expect(manager.get(third)).toEqual({ kind: "expired" });
    expect(manager.get(fourth)).toMatchObject({
      kind: "found",
      status: { state: "succeeded" },
    });
  });

  it("returns degraded evidence as a successful completed result", async () => {
    const artifact = liveExtractionArtifact();
    expect(artifact.evidence.status).toBe("degraded");
    const manager = new LiveExtractionJobManager({
      runner: () => Promise.resolve(artifact),
      createJobId: jobIdGenerator(),
    });
    const started = manager.start(REQUEST_1);
    if (!started.ok) throw new Error("Expected the degraded-evidence job to start.");
    await flushMicrotasks();

    expect(manager.get(started.response.jobId)).toMatchObject({
      kind: "found",
      status: {
        state: "succeeded",
        result: { evidence: { status: "degraded" } },
      },
    });
  });

  it.each(["valid", "invalid"] as const)(
    "returns %s evidence as a successful completed result",
    async (evidenceStatus) => {
      const fixture = liveExtractionArtifact();
      const artifact = LiveExtractionArtifactSchema.parse({
        ...fixture,
        evidence: { ...fixture.evidence, status: evidenceStatus },
      });
      const manager = new LiveExtractionJobManager({
        runner: () => Promise.resolve(artifact),
        createJobId: jobIdGenerator(),
      });
      const started = manager.start(REQUEST_1);
      if (!started.ok) throw new Error("Expected the evidence-status job to start.");
      await flushMicrotasks();

      expect(manager.get(started.response.jobId)).toMatchObject({
        kind: "found",
        status: {
          state: "succeeded",
          result: { evidence: { status: evidenceStatus } },
        },
      });
    },
  );
});
