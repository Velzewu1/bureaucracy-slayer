import { randomBytes } from "node:crypto";

import {
  LIVE_EXTRACTION_JOB_TIMEOUT_MS,
  LIVE_EXTRACTION_POLL_INTERVAL_MS,
  LIVE_EXTRACTION_START_ROUTE,
  LIVE_EXTRACTION_TERMINAL_RETENTION_MS,
  LiveExtractionFailureSchema,
  LiveExtractionGoalSchema,
  LIVE_EXTRACTION_LEGACY_GOAL,
  type LiveExtractionArtifact,
  type LiveExtractionFailure,
  type LiveExtractionGoal,
  type LiveExtractionJobId,
  type LiveExtractionJobStatus,
  type LiveExtractionRequestId,
  type LiveExtractionStartResponse,
} from "./live-extraction-contract.js";

export type LiveExtractionRunningPhase =
  | "collecting"
  | "selecting_sources"
  | "extracting_policy"
  | "mapping_procedure"
  | "validating";

export type LiveExtractionRunContext = Readonly<{
  deadlineAtMs: number;
  goal: LiveExtractionGoal;
  setPhase(phase: LiveExtractionRunningPhase): void;
}>;

export type LiveExtractionRunner = (
  context: LiveExtractionRunContext,
) => Promise<LiveExtractionArtifact>;

export class LiveExtractionPipelineError extends Error {
  readonly failure: LiveExtractionFailure;

  constructor(failure: LiveExtractionFailure) {
    super(failure.message);
    this.name = "LiveExtractionPipelineError";
    this.failure = LiveExtractionFailureSchema.parse(failure);
  }
}

export type LiveExtractionJobClock = Readonly<{
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}>;

export type LiveExtractionJobManagerOptions = Readonly<{
  runner: LiveExtractionRunner;
  /** Trusted server startup identity; never accepted from the HTTP request. */
  portalIdentity?: string;
  clock?: LiveExtractionJobClock;
  createJobId?: () => LiveExtractionJobId;
  timeoutMs?: number;
  terminalRetentionMs?: number;
  terminalResultLimit?: number;
  tombstoneLimit?: number;
}>;

export type StartJobOutcome =
  | Readonly<{ ok: true; response: LiveExtractionStartResponse }>
  | Readonly<{ ok: false; failure: LiveExtractionFailure }>;

export type GetJobOutcome =
  | Readonly<{ kind: "found"; status: LiveExtractionJobStatus }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "missing" }>;

type JobRecord = {
  status: LiveExtractionJobStatus;
  binding: JobBinding;
};

type JobBinding = Readonly<{
  goal: LiveExtractionGoal;
  portalIdentity: string;
}>;

type Tombstone = Readonly<{
  jobId: LiveExtractionJobId;
  requestId: LiveExtractionRequestId;
  binding: JobBinding;
  // Minimal expiration metadata needed to replay the frozen idempotent start response.
  stateAtExpiration: "succeeded" | "failed";
  expiresAtMs: number;
}>;

const DEFAULT_TERMINAL_RESULT_LIMIT = 2;
const DEFAULT_TOMBSTONE_LIMIT = 16;

const systemClock: LiveExtractionJobClock = {
  now: () => new Date(),
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle),
};

function randomJobId(): LiveExtractionJobId {
  return `job_${randomBytes(16).toString("hex")}`;
}

function isoAt(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function internalFailure(): LiveExtractionFailure {
  return {
    code: "INTERNAL_ERROR",
    stage: "internal",
    message: "The live extraction failed unexpectedly.",
    retryable: false,
    issueCodes: [],
  };
}

function timeoutFailure(): LiveExtractionFailure {
  return {
    code: "JOB_TIMED_OUT",
    stage: "timeout",
    message:
      "The live extraction exceeded its deadline. Underlying work may still be settling.",
    retryable: false,
    issueCodes: [],
  };
}

function occupiedFailure(): LiveExtractionFailure {
  return {
    code: "JOB_ALREADY_RUNNING",
    stage: "job",
    message: "A live extraction is already physically in progress.",
    retryable: false,
    issueCodes: [],
  };
}

function identityMismatchFailure(): LiveExtractionFailure {
  return {
    code: "REQUEST_IDENTITY_MISMATCH",
    stage: "request",
    message: "The request ID is already bound to a different goal or trusted portal.",
    retryable: false,
    issueCodes: ["REQUEST_IDENTITY_MISMATCH"],
  };
}

function sameBinding(left: JobBinding, right: JobBinding): boolean {
  return left.goal === right.goal && left.portalIdentity === right.portalIdentity;
}

export class LiveExtractionJobManager {
  readonly #runner: LiveExtractionRunner;
  readonly #portalIdentity: string;
  readonly #clock: LiveExtractionJobClock;
  readonly #createJobId: () => LiveExtractionJobId;
  readonly #timeoutMs: number;
  readonly #terminalRetentionMs: number;
  readonly #terminalResultLimit: number;
  readonly #tombstoneLimit: number;
  readonly #jobs = new Map<LiveExtractionJobId, JobRecord>();
  readonly #requestJobs = new Map<LiveExtractionRequestId, LiveExtractionJobId>();
  readonly #jobTombstones = new Map<LiveExtractionJobId, Tombstone>();
  readonly #requestTombstones = new Map<LiveExtractionRequestId, Tombstone>();
  readonly #terminalOrder: LiveExtractionJobId[] = [];
  readonly #tombstoneOrder: LiveExtractionJobId[] = [];
  #physicalWorkerJobId: LiveExtractionJobId | undefined;
  #cleanupHandle: ReturnType<typeof setTimeout> | undefined;

  constructor(options: LiveExtractionJobManagerOptions) {
    this.#runner = options.runner;
    this.#portalIdentity = options.portalIdentity ?? "legacy-controlled-portal";
    this.#clock = options.clock ?? systemClock;
    this.#createJobId = options.createJobId ?? randomJobId;
    this.#timeoutMs = options.timeoutMs ?? LIVE_EXTRACTION_JOB_TIMEOUT_MS;
    this.#terminalRetentionMs =
      options.terminalRetentionMs ?? LIVE_EXTRACTION_TERMINAL_RETENTION_MS;
    this.#terminalResultLimit =
      options.terminalResultLimit ?? DEFAULT_TERMINAL_RESULT_LIMIT;
    this.#tombstoneLimit = options.tombstoneLimit ?? DEFAULT_TOMBSTONE_LIMIT;
    if (
      this.#timeoutMs <= 0 ||
      this.#terminalRetentionMs <= 0 ||
      this.#terminalResultLimit <= 0 ||
      this.#tombstoneLimit <= 0
    ) {
      throw new TypeError("Live extraction job limits must be positive.");
    }
  }

  start(
    requestId: LiveExtractionRequestId,
    goalInput: string = LIVE_EXTRACTION_LEGACY_GOAL,
  ): StartJobOutcome {
    this.#cleanup();
    const goal = LiveExtractionGoalSchema.safeParse(goalInput);
    if (!goal.success) {
      return {
        ok: false,
        failure: {
          code: "REQUEST_INVALID",
          stage: "request",
          message: "The extraction goal is invalid.",
          retryable: false,
          issueCodes: ["GOAL_INVALID"],
        },
      };
    }
    const binding: JobBinding = {
      goal: goal.data,
      portalIdentity: this.#portalIdentity,
    };

    const retainedJobId = this.#requestJobs.get(requestId);
    if (retainedJobId !== undefined) {
      const retained = this.#jobs.get(retainedJobId);
      if (retained !== undefined) {
        if (!sameBinding(retained.binding, binding)) {
          return { ok: false, failure: identityMismatchFailure() };
        }
        return { ok: true, response: this.#startResponse(retained.status) };
      }
    }

    const tombstone = this.#requestTombstones.get(requestId);
    if (tombstone !== undefined) {
      if (!sameBinding(tombstone.binding, binding)) {
        return { ok: false, failure: identityMismatchFailure() };
      }
      return {
        ok: true,
        response: {
          schemaVersion: 1,
          jobId: tombstone.jobId,
          state: tombstone.stateAtExpiration,
          statusUrl: `${LIVE_EXTRACTION_START_ROUTE}/${tombstone.jobId}`,
          pollAfterMs: LIVE_EXTRACTION_POLL_INTERVAL_MS,
        },
      };
    }

    if (this.#physicalWorkerJobId !== undefined) {
      return { ok: false, failure: occupiedFailure() };
    }

    const jobId = this.#newJobId();
    const now = this.#clock.now().toISOString();
    const status: LiveExtractionJobStatus = {
      schemaVersion: 1,
      jobId,
      requestId,
      state: "queued",
      phase: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.#jobs.set(jobId, { status, binding });
    this.#requestJobs.set(requestId, jobId);
    this.#physicalWorkerJobId = jobId;
    queueMicrotask(() => void this.#execute(jobId));
    return { ok: true, response: this.#startResponse(status) };
  }

  get(jobId: LiveExtractionJobId): GetJobOutcome {
    this.#cleanup();
    const record = this.#jobs.get(jobId);
    if (record !== undefined) return { kind: "found", status: record.status };
    if (this.#jobTombstones.has(jobId)) return { kind: "expired" };
    return { kind: "missing" };
  }

  #startResponse(status: LiveExtractionJobStatus): LiveExtractionStartResponse {
    return {
      schemaVersion: 1,
      jobId: status.jobId,
      state: status.state,
      statusUrl: `${LIVE_EXTRACTION_START_ROUTE}/${status.jobId}`,
      pollAfterMs: LIVE_EXTRACTION_POLL_INTERVAL_MS,
    };
  }

  #newJobId(): LiveExtractionJobId {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = this.#createJobId();
      if (!this.#jobs.has(candidate) && !this.#jobTombstones.has(candidate)) return candidate;
    }
    throw new Error("Could not allocate a unique live extraction job ID.");
  }

  async #execute(jobId: LiveExtractionJobId): Promise<void> {
    const record = this.#jobs.get(jobId);
    if (record === undefined || record.status.state !== "queued") {
      if (this.#physicalWorkerJobId === jobId) this.#physicalWorkerJobId = undefined;
      return;
    }

    const startedAtDate = this.#clock.now();
    const startedAt = startedAtDate.toISOString();
    const deadlineAtMs = startedAtDate.getTime() + this.#timeoutMs;
    record.status = {
      ...record.status,
      state: "running",
      phase: "collecting",
      startedAt,
      updatedAt: startedAt,
    };
    const deadlineHandle = this.#clock.setTimeout(() => {
      this.#finish(jobId, { kind: "failure", failure: timeoutFailure() });
    }, this.#timeoutMs);

    try {
      const result = await this.#runner({
        deadlineAtMs,
        goal: record.binding.goal,
        setPhase: (phase) => this.#setPhase(jobId, phase),
      });
      this.#finish(jobId, { kind: "success", result });
    } catch (error) {
      this.#finish(jobId, {
        kind: "failure",
        failure:
          error instanceof LiveExtractionPipelineError ? error.failure : internalFailure(),
      });
    } finally {
      this.#clock.clearTimeout(deadlineHandle);
      if (this.#physicalWorkerJobId === jobId) this.#physicalWorkerJobId = undefined;
      this.#cleanup();
    }
  }

  #setPhase(jobId: LiveExtractionJobId, phase: LiveExtractionRunningPhase): void {
    const record = this.#jobs.get(jobId);
    if (record === undefined || record.status.state !== "running") return;
    const updatedAt = this.#clock.now().toISOString();
    record.status = { ...record.status, phase, updatedAt };
  }

  #finish(
    jobId: LiveExtractionJobId,
    outcome:
      | Readonly<{ kind: "success"; result: LiveExtractionArtifact }>
      | Readonly<{ kind: "failure"; failure: LiveExtractionFailure }>,
  ): void {
    const record = this.#jobs.get(jobId);
    if (record === undefined || record.status.state !== "running") return;
    const completedAtMs = this.#clock.now().getTime();
    const completedAt = isoAt(completedAtMs);
    const expiresAt = isoAt(completedAtMs + this.#terminalRetentionMs);
    record.status =
      outcome.kind === "success"
        ? {
            ...record.status,
            state: "succeeded",
            phase: "complete",
            updatedAt: completedAt,
            completedAt,
            expiresAt,
            result: outcome.result,
          }
        : {
            ...record.status,
            state: "failed",
            phase: "failed",
            updatedAt: completedAt,
            completedAt,
            expiresAt,
            error: outcome.failure,
          };
    this.#terminalOrder.push(jobId);
    this.#enforceTerminalLimit(completedAtMs);
    this.#scheduleCleanup();
  }

  #cleanup(): void {
    const nowMs = this.#clock.now().getTime();
    for (const jobId of [...this.#terminalOrder]) {
      const status = this.#jobs.get(jobId)?.status;
      if (
        status !== undefined &&
        (status.state === "succeeded" || status.state === "failed") &&
        Date.parse(status.expiresAt) <= nowMs
      ) {
        this.#evictToTombstone(
          jobId,
          Date.parse(status.expiresAt) + this.#terminalRetentionMs,
        );
      }
    }
    for (const jobId of [...this.#tombstoneOrder]) {
      const tombstone = this.#jobTombstones.get(jobId);
      if (tombstone !== undefined && tombstone.expiresAtMs <= nowMs) {
        this.#removeTombstone(tombstone);
      }
    }
    this.#scheduleCleanup();
  }

  #enforceTerminalLimit(nowMs: number): void {
    while (this.#terminalOrder.length > this.#terminalResultLimit) {
      const oldest = this.#terminalOrder[0];
      if (oldest === undefined) return;
      this.#evictToTombstone(oldest, nowMs + this.#terminalRetentionMs);
    }
  }

  #evictToTombstone(jobId: LiveExtractionJobId, expiresAtMs: number): void {
    const record = this.#jobs.get(jobId);
    if (
      record === undefined ||
      (record.status.state !== "succeeded" && record.status.state !== "failed")
    ) {
      return;
    }
    const tombstone: Tombstone = {
      jobId,
      requestId: record.status.requestId,
      binding: record.binding,
      stateAtExpiration: record.status.state,
      expiresAtMs,
    };
    this.#jobs.delete(jobId);
    this.#requestJobs.delete(record.status.requestId);
    const terminalIndex = this.#terminalOrder.indexOf(jobId);
    if (terminalIndex >= 0) this.#terminalOrder.splice(terminalIndex, 1);
    this.#jobTombstones.set(jobId, tombstone);
    this.#requestTombstones.set(tombstone.requestId, tombstone);
    this.#tombstoneOrder.push(jobId);
    while (this.#tombstoneOrder.length > this.#tombstoneLimit) {
      const oldest = this.#tombstoneOrder[0];
      if (oldest === undefined) break;
      const oldestTombstone = this.#jobTombstones.get(oldest);
      if (oldestTombstone !== undefined) this.#removeTombstone(oldestTombstone);
      else this.#tombstoneOrder.shift();
    }
  }

  #removeTombstone(tombstone: Tombstone): void {
    this.#jobTombstones.delete(tombstone.jobId);
    this.#requestTombstones.delete(tombstone.requestId);
    const index = this.#tombstoneOrder.indexOf(tombstone.jobId);
    if (index >= 0) this.#tombstoneOrder.splice(index, 1);
  }

  #scheduleCleanup(): void {
    if (this.#cleanupHandle !== undefined) {
      this.#clock.clearTimeout(this.#cleanupHandle);
      this.#cleanupHandle = undefined;
    }
    const terminalExpirations = this.#terminalOrder.flatMap((jobId) => {
      const status = this.#jobs.get(jobId)?.status;
      return status !== undefined &&
        (status.state === "succeeded" || status.state === "failed")
        ? [Date.parse(status.expiresAt)]
        : [];
    });
    const tombstoneExpirations = this.#tombstoneOrder.flatMap((jobId) => {
      const expiresAtMs = this.#jobTombstones.get(jobId)?.expiresAtMs;
      return expiresAtMs === undefined ? [] : [expiresAtMs];
    });
    const nextExpiration = [...terminalExpirations, ...tombstoneExpirations]
      .sort((left, right) => left - right)[0];
    if (nextExpiration === undefined) return;
    const delayMs = Math.max(0, nextExpiration - this.#clock.now().getTime());
    this.#cleanupHandle = this.#clock.setTimeout(() => {
      this.#cleanupHandle = undefined;
      this.#cleanup();
    }, delayMs);
  }
}
