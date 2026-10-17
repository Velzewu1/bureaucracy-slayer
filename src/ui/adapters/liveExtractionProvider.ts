import { z } from "zod";

import {
  UserStateSchema,
  hashCanonical,
  type EvidenceResult,
  type UserState,
} from "../../contracts/index.js";
import { analyzeDecisionIntelligence } from "../../decision/index.js";
import { evaluatePolicies, planActions } from "../../engine/index.js";
import {
  LIVE_EXTRACTION_POLL_INTERVAL_MS,
  LIVE_EXTRACTION_START_ROUTE,
  LIVE_EXTRACTION_TERMINAL_RETENTION_MS,
  LiveExtractionErrorResponseSchema,
  LiveExtractionJobIdSchema,
  LiveExtractionJobStatusSchema,
  LiveExtractionRequestIdSchema,
  LiveExtractionStartRequestSchema,
  LiveExtractionStartResponseSchema,
  type LiveExtractionClientStopReason,
  type LiveExtractionFailureCode,
  type LiveExtractionJobId,
  type LiveExtractionJobStatus,
  type LiveExtractionRequestId,
} from "../../orchestration/live-extraction-contract.js";
import type {
  AnalysisProgress,
  AnalysisRequest,
  AnalysisRunOptions,
  DemoAnalysis,
  DemoDataProvider,
  LiveExtractionPhase,
  LiveResumeState,
} from "../types.js";
import {
  recordedExtractionBundle,
} from "./recordedExtractionProvider.js";
import {
  LiveArtifactIntegrityError,
  verifyLiveExtractionArtifact,
  type VerifiedLiveArtifact,
} from "./liveArtifactVerification.js";

export const LIVE_DEMO_GOAL = recordedExtractionBundle.extractionGoal;
export const LIVE_DEMO_PORTAL_URL = recordedExtractionBundle.sourceSnapshot.rootUrl;

export type LiveExtractionClientErrorCode =
  | LiveExtractionFailureCode
  | "TRANSPORT_ERROR"
  | "MALFORMED_RESPONSE"
  | "RESPONSE_IDENTITY_MISMATCH"
  | "GOAL_MISMATCH"
  | "PORTAL_MISMATCH"
  | "RECOVERY_STATE_INVALID"
  | "SOURCE_POLICY_MISMATCH"
  | "SESSION_MISSING"
  | "CLIENT_STOPPED";

const failureHeadings: Partial<Readonly<Record<LiveExtractionFailureCode, string>>> = {
  JOB_ALREADY_RUNNING: "Another live extraction is already using the local worker.",
  PORTAL_UNAVAILABLE: "The controlled portal is unavailable.",
  COLLECTOR_UNAVAILABLE: "The browser collector is unavailable.",
  JOB_EXPIRED: "The live extraction result expired before it could be loaded.",
  JOB_NOT_FOUND: "The live extraction job is no longer available.",
  JOB_TIMED_OUT: "The live extraction exceeded its bounded runtime.",
  CONFIGURATION_INVALID: "The live extraction server is not configured.",
};

export class LiveExtractionClientError extends Error {
  readonly code: LiveExtractionClientErrorCode;

  constructor(code: LiveExtractionClientErrorCode, message: string) {
    super(message);
    this.name = "LiveExtractionClientError";
    this.code = code;
  }
}

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type WaitImplementation = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export const LIVE_EXTRACTION_RECOVERY_STORAGE_KEY =
  "bureaucracy-slayer.live-extraction.recovery.v1";

const LIVE_EXTRACTION_REQUEST_RECOVERY_MAX_AGE_MS =
  LIVE_EXTRACTION_TERMINAL_RETENTION_MS - 60_000;
const LIVE_EXTRACTION_RECOVERY_CLOCK_SKEW_MS = 60_000;

export type LiveExtractionRecoveryStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

const LiveExtractionRecoveryMetadataSchema = z.discriminatedUnion("kind", [
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("request"),
      requestId: LiveExtractionRequestIdSchema,
      createdAtMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal("job"),
      requestId: LiveExtractionRequestIdSchema,
      createdAtMs: z.number().int().nonnegative(),
      jobId: LiveExtractionJobIdSchema,
      statusUrl: z.string().min(1),
    })
    .strict(),
]);

export type LiveExtractionProviderOptions = Readonly<{
  expectedSource?: "live" | "offline_mock";
  fetch?: FetchImplementation;
  generateRequestId?: () => LiveExtractionRequestId;
  now?: () => string;
  nowMs?: () => number;
  storage?: LiveExtractionRecoveryStorage;
  wait?: WaitImplementation;
}>;

type ActiveRequest = {
  requestId: LiveExtractionRequestId;
  requestState: "pending" | "ambiguous";
  createdAtMs: number;
  jobId?: LiveExtractionJobId;
  statusUrl?: string;
};

type Operation = {
  controller: AbortController;
  stopReason: LiveExtractionClientStopReason | null;
};

type LiveSession = Readonly<{
  id: string;
  responseSource: "live" | "offline_mock";
  verified: VerifiedLiveArtifact;
}>;

type TerminalJobStatus =
  | Extract<LiveExtractionJobStatus, { state: "succeeded" }>
  | Extract<LiveExtractionJobStatus, { state: "failed" }>;

function shortHash(value: unknown): string {
  return hashCanonical(value).slice(0, 20);
}

function generateRequestId(): LiveExtractionRequestId {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return LiveExtractionStartRequestSchema.parse({
    schemaVersion: 1,
    action: "start_live_extraction",
    requestId: `request_${hex}`,
  }).requestId;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("The polling wait was stopped.", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new DOMException("The polling wait was stopped.", "AbortError"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  if (contentType === null) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

function browserSessionStorage(): Readonly<{
  storage?: LiveExtractionRecoveryStorage;
  unavailable: boolean;
}> {
  if (typeof window === "undefined") return { unavailable: false };
  try {
    return { storage: window.sessionStorage, unavailable: false };
  } catch {
    return { unavailable: true };
  }
}

async function parseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (isAbortError(error)) throw error;
    throw new LiveExtractionClientError(
      "MALFORMED_RESPONSE",
      "The live extraction server returned malformed JSON.",
    );
  }
}

function operationalError(input: unknown): LiveExtractionClientError | undefined {
  const parsed = LiveExtractionErrorResponseSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const failure = parsed.data.error;
  const heading = failureHeadings[failure.code];
  return new LiveExtractionClientError(
    failure.code,
    heading === undefined ? failure.message : `${heading} ${failure.message}`,
  );
}

function isDefinitiveStartRejection(
  code: LiveExtractionClientErrorCode,
): boolean {
  switch (code) {
    case "REQUEST_INVALID":
    case "REQUEST_TOO_LARGE":
    case "UNSUPPORTED_ACTION":
    case "UNSUPPORTED_MEDIA_TYPE":
    case "JOB_ALREADY_RUNNING":
      return true;
    default:
      return false;
  }
}

function phaseForStatus(status: LiveExtractionJobStatus): LiveExtractionPhase {
  switch (status.state) {
    case "queued":
      return "queued";
    case "running":
      return status.phase;
    case "succeeded":
      return "complete";
    case "failed":
      return "failed";
  }
}

export class LiveExtractionProvider implements DemoDataProvider {
  readonly #fetch: FetchImplementation;
  readonly #generateRequestId: () => LiveExtractionRequestId;
  readonly #now: () => string;
  readonly #nowMs: () => number;
  readonly #storage: LiveExtractionRecoveryStorage | undefined;
  readonly #wait: WaitImplementation;
  readonly #expectedSource: "live" | "offline_mock" | undefined;
  #recoveryBlocked: boolean;
  #responseSource: "live" | "offline_mock" | undefined;
  #session: LiveSession | undefined;
  #activeRequest: ActiveRequest | undefined;
  #operation: Operation | undefined;
  #inFlight: Promise<DemoAnalysis> | undefined;

  constructor(options: LiveExtractionProviderOptions = {}) {
    const defaultStorage = browserSessionStorage();
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#generateRequestId = options.generateRequestId ?? generateRequestId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#nowMs = options.nowMs ?? Date.now;
    this.#storage = options.storage ?? defaultStorage.storage;
    this.#wait = options.wait ?? wait;
    this.#expectedSource = options.expectedSource;
    this.#recoveryBlocked = options.storage === undefined && defaultStorage.unavailable;
    this.#restoreRecovery();
  }

  #restoreRecovery(): void {
    if (this.#storage === undefined || this.#recoveryBlocked) return;
    let serialized: string | null;
    try {
      serialized = this.#storage.getItem(LIVE_EXTRACTION_RECOVERY_STORAGE_KEY);
    } catch {
      this.#recoveryBlocked = true;
      return;
    }
    if (serialized === null) return;
    let input: unknown;
    try {
      input = JSON.parse(serialized);
    } catch {
      this.#recoveryBlocked = true;
      return;
    }
    const parsed = LiveExtractionRecoveryMetadataSchema.safeParse(input);
    if (!parsed.success) {
      this.#recoveryBlocked = true;
      return;
    }
    const metadata = parsed.data;
    if (metadata.kind === "job") {
      if (metadata.statusUrl !== `${LIVE_EXTRACTION_START_ROUTE}/${metadata.jobId}`) {
        this.#recoveryBlocked = true;
        return;
      }
      this.#activeRequest = {
        requestId: metadata.requestId,
        requestState: "ambiguous",
        createdAtMs: metadata.createdAtMs,
        jobId: metadata.jobId,
        statusUrl: metadata.statusUrl,
      };
      return;
    }
    const ageMs = this.#nowMs() - metadata.createdAtMs;
    if (
      ageMs < -LIVE_EXTRACTION_RECOVERY_CLOCK_SKEW_MS ||
      ageMs >= LIVE_EXTRACTION_REQUEST_RECOVERY_MAX_AGE_MS
    ) {
      this.#recoveryBlocked = true;
      return;
    }
    this.#activeRequest = {
      requestId: metadata.requestId,
      requestState: "ambiguous",
      createdAtMs: metadata.createdAtMs,
    };
  }

  #persistRecovery(active: ActiveRequest, required: boolean): void {
    if (this.#storage === undefined) return;
    const metadata =
      active.jobId !== undefined && active.statusUrl !== undefined
        ? {
            schemaVersion: 1 as const,
            kind: "job" as const,
            requestId: active.requestId,
            createdAtMs: active.createdAtMs,
            jobId: active.jobId,
            statusUrl: active.statusUrl,
          }
        : {
            schemaVersion: 1 as const,
            kind: "request" as const,
            requestId: active.requestId,
            createdAtMs: active.createdAtMs,
          };
    try {
      this.#storage.setItem(
        LIVE_EXTRACTION_RECOVERY_STORAGE_KEY,
        JSON.stringify(LiveExtractionRecoveryMetadataSchema.parse(metadata)),
      );
    } catch {
      if (!required) return;
      this.#recoveryBlocked = true;
      throw new LiveExtractionClientError(
        "RECOVERY_STATE_INVALID",
        "Live extraction could not start because recovery metadata could not be stored safely.",
      );
    }
  }

  #clearRecovery(): void {
    this.#activeRequest = undefined;
    if (this.#storage === undefined) return;
    try {
      this.#storage.removeItem(LIVE_EXTRACTION_RECOVERY_STORAGE_KEY);
    } catch {
      // A retained known job remains safe to re-read; never replace it with a new ID here.
    }
  }

  #emit(
    options: AnalysisRunOptions | undefined,
    phase: LiveExtractionPhase,
    jobId?: string,
  ): void {
    const progress: AnalysisProgress =
      jobId === undefined ? { phase } : { phase, jobId };
    options?.onProgress?.(progress);
  }

  async #responseBody(
    response: Response,
    expectedStatus: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!isJsonResponse(response)) {
      if (response.status >= 500 && response.status <= 599) {
        throw new LiveExtractionClientError(
          "TRANSPORT_ERROR",
          "The live extraction API is unavailable through the local proxy. The backend job may still be running.",
        );
      }
      throw new LiveExtractionClientError(
        "MALFORMED_RESPONSE",
        "The live extraction server returned a response that was not declared as JSON.",
      );
    }
    const responseSource =
      response.headers.get("x-bureaucracy-slayer-offline-mock") === "1"
        ? "offline_mock"
        : "live";
    if (
      this.#expectedSource !== undefined &&
      responseSource !== this.#expectedSource
    ) {
      throw new LiveExtractionClientError(
        "SOURCE_POLICY_MISMATCH",
        this.#expectedSource === "offline_mock"
          ? "Offline demonstration mode refused a response that was not marked by the deterministic mock API."
          : "Live analysis mode refused a deterministic mock response that was not explicitly configured.",
      );
    }
    if (
      this.#responseSource !== undefined &&
      responseSource !== this.#responseSource
    ) {
      throw new LiveExtractionClientError(
        "SOURCE_POLICY_MISMATCH",
        "The analysis API changed provenance during one extraction job.",
      );
    }
    this.#responseSource = responseSource;
    const body = await parseJson(response, signal);
    signal.throwIfAborted();
    if (response.status === expectedStatus) return body;
    const error = operationalError(body);
    if (error !== undefined) throw error;
    throw new LiveExtractionClientError(
      "MALFORMED_RESPONSE",
      `The live extraction server returned an unexpected HTTP ${response.status} response.`,
    );
  }

  async #start(
    active: ActiveRequest,
    signal: AbortSignal,
  ): Promise<Readonly<{ jobId: string; statusUrl: string }>> {
    if (active.jobId !== undefined && active.statusUrl !== undefined) {
      return { jobId: active.jobId, statusUrl: active.statusUrl };
    }
    const request = LiveExtractionStartRequestSchema.parse({
      schemaVersion: 1,
      action: "start_live_extraction",
      requestId: active.requestId,
    });
    active.requestState = "pending";
    let response: Response;
    try {
      response = await this.#fetch(LIVE_EXTRACTION_START_ROUTE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      active.requestState = "ambiguous";
      throw new LiveExtractionClientError(
        "TRANSPORT_ERROR",
        "The live extraction API could not be reached. Check that the local server is running.",
      );
    }
    signal.throwIfAborted();
    const body = await this.#responseBody(response, 202, signal);
    signal.throwIfAborted();
    const parsed = LiveExtractionStartResponseSchema.safeParse(body);
    if (!parsed.success) {
      active.requestState = "ambiguous";
      throw new LiveExtractionClientError(
        "MALFORMED_RESPONSE",
        "The live extraction start response did not match the frozen API contract.",
      );
    }
    active.jobId = parsed.data.jobId;
    active.statusUrl = parsed.data.statusUrl;
    this.#persistRecovery(active, false);
    return { jobId: parsed.data.jobId, statusUrl: parsed.data.statusUrl };
  }

  async #poll(
    active: ActiveRequest,
    job: Readonly<{ jobId: string; statusUrl: string }>,
    signal: AbortSignal,
    options: AnalysisRunOptions | undefined,
  ): Promise<TerminalJobStatus> {
    while (true) {
      await this.#wait(LIVE_EXTRACTION_POLL_INTERVAL_MS, signal);
      let response: Response;
      try {
        response = await this.#fetch(job.statusUrl, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal,
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new LiveExtractionClientError(
          "TRANSPORT_ERROR",
          "Polling the live extraction failed. The backend job may still be running.",
        );
      }
      signal.throwIfAborted();
      const body = await this.#responseBody(response, 200, signal);
      signal.throwIfAborted();
      const parsed = LiveExtractionJobStatusSchema.safeParse(body);
      if (!parsed.success) {
        throw new LiveExtractionClientError(
          "MALFORMED_RESPONSE",
          "The live extraction status response did not match the frozen API contract.",
        );
      }
      const status = parsed.data;
      if (status.jobId !== job.jobId || status.requestId !== active.requestId) {
        throw new LiveExtractionClientError(
          "RESPONSE_IDENTITY_MISMATCH",
          "The live extraction response was bound to a different request or job.",
        );
      }
      this.#emit(options, phaseForStatus(status), status.jobId);
      if (status.state === "succeeded" || status.state === "failed") return status;
    }
  }

  #buildAnalysis(
    session: LiveSession,
    userStateInput: UserState,
  ): DemoAnalysis {
    const userState = UserStateSchema.parse(userStateInput);
    const { artifact, evidence, semanticAudit } = session.verified;
    const evaluation = evaluatePolicies(artifact.procedureModel, evidence, userState);
    const plan = planActions(
      artifact.procedureModel,
      evidence,
      evaluation,
      userState,
      {
        planId: `plan_${shortHash({
          kind: "live_sonnet",
          sessionId: session.id,
          userState,
        })}`,
        generatedAt: this.#now(),
        userStateHash: hashCanonical(userState),
      },
    );
    const analysis: Omit<DemoAnalysis, "decisionIntelligence"> = {
      sessionId: session.id,
      mode: "live_sonnet",
      replanMode: "deterministic_engine",
      goal: artifact.goal,
      portalName:
        session.responseSource === "offline_mock"
          ? "Northstar Mock Bank (offline mock replay)"
          : "Northstar Mock Bank (live extraction)",
      portalUrl: artifact.portalUrl,
      snapshot: artifact.sourceSnapshot,
      model: artifact.procedureModel,
      evidence,
      evaluation,
      plan,
      userState,
      semanticAuditFindings: semanticAudit.findings,
      source: {
        kind:
          session.responseSource === "offline_mock"
            ? "offline_mock_replay"
            : "live_extraction",
        label:
          session.responseSource === "offline_mock"
            ? "Deterministic offline mock"
            : "Live Sonnet extraction",
        extractionPreviouslyCompleted: session.responseSource === "offline_mock",
        modelName: artifact.provenance.modelName,
        recordedAt: artifact.provenance.completedAt,
      },
    };
    return {
      ...analysis,
      decisionIntelligence: analyzeDecisionIntelligence(analysis),
    };
  }

  async #run(
    request: AnalysisRequest,
    options: AnalysisRunOptions | undefined,
    operation: Operation,
  ): Promise<DemoAnalysis> {
    if (request.goal !== LIVE_DEMO_GOAL) {
      throw new LiveExtractionClientError(
        "GOAL_MISMATCH",
        "Live Sonnet mode is locked to the server-owned extraction goal.",
      );
    }
    if (request.portalUrl !== LIVE_DEMO_PORTAL_URL) {
      throw new LiveExtractionClientError(
        "PORTAL_MISMATCH",
        "Live Sonnet mode is locked to the controlled local portal.",
      );
    }

    if (this.#recoveryBlocked && this.#activeRequest === undefined) {
      throw new LiveExtractionClientError(
        "RECOVERY_STATE_INVALID",
        "Stored live extraction recovery metadata was invalid or too old to retry safely. Close this tab to begin a new browser session.",
      );
    }
    let active = this.#activeRequest;
    if (active === undefined) {
      active = {
        requestId: this.#generateRequestId(),
        requestState: "pending",
        createdAtMs: this.#nowMs(),
      };
      this.#activeRequest = active;
      this.#persistRecovery(active, true);
    }
    this.#emit(options, "queued");

    try {
      const job = await this.#start(active, operation.controller.signal);
      this.#emit(options, "queued", job.jobId);
      const status = await this.#poll(
        active,
        job,
        operation.controller.signal,
        options,
      );
      if (status.state === "failed") {
        this.#clearRecovery();
        const heading = failureHeadings[status.error.code];
        throw new LiveExtractionClientError(
          status.error.code,
          heading === undefined ? status.error.message : `${heading} ${status.error.message}`,
        );
      }

      const verified = verifyLiveExtractionArtifact(status.result);
      if (verified.artifact.goal !== LIVE_DEMO_GOAL) {
        throw new LiveExtractionClientError(
          "GOAL_MISMATCH",
          "The live result did not match the fixed extraction goal.",
        );
      }
      if (verified.artifact.portalUrl !== LIVE_DEMO_PORTAL_URL) {
        throw new LiveExtractionClientError(
          "PORTAL_MISMATCH",
          "The live result did not match the controlled local portal.",
        );
      }
      const session: LiveSession = {
        id: `session_${job.jobId.slice("job_".length)}`,
        responseSource: this.#responseSource ?? "live",
        verified,
      };
      this.#session = session;
      this.#clearRecovery();
      return this.#buildAnalysis(session, request.userState);
    } catch (error) {
      if (isAbortError(error)) {
        throw new LiveExtractionClientError(
          "CLIENT_STOPPED",
          `Live polling stopped locally (${operation.stopReason ?? "component_unmounted"}). The backend job was not cancelled.`,
        );
      }
      if (
        error instanceof LiveExtractionClientError &&
        (error.code === "JOB_EXPIRED" || error.code === "JOB_NOT_FOUND") &&
        this.#activeRequest === active
      ) {
        this.#clearRecovery();
      }
      if (
        error instanceof LiveExtractionClientError &&
        active.jobId === undefined &&
        this.#activeRequest === active
      ) {
        if (isDefinitiveStartRejection(error.code)) {
          this.#clearRecovery();
        } else {
          active.requestState = "ambiguous";
        }
      }
      if (
        error instanceof LiveExtractionClientError ||
        error instanceof LiveArtifactIntegrityError
      ) {
        throw error;
      }
      throw new LiveExtractionClientError(
        "TRANSPORT_ERROR",
        "The live extraction could not be completed because of an unexpected client error.",
      );
    }
  }

  analyze(
    request: AnalysisRequest,
    options?: AnalysisRunOptions,
  ): Promise<DemoAnalysis> {
    if (this.#inFlight !== undefined) {
      if (this.#operation?.controller.signal.aborted === true) {
        return this.#inFlight
          .catch(() => undefined)
          .then(() => this.analyze(request, options));
      }
      return this.#inFlight;
    }
    const operation: Operation = {
      controller: new AbortController(),
      stopReason: null,
    };
    this.#operation = operation;
    const run = this.#run(request, options, operation).finally(() => {
      if (this.#operation === operation) {
        this.#operation = undefined;
        this.#inFlight = undefined;
      }
    });
    this.#inFlight = run;
    return run;
  }

  stop(reason: LiveExtractionClientStopReason): void {
    const operation = this.#operation;
    if (operation === undefined) return;
    operation.stopReason = reason;
    const active = this.#activeRequest;
    if (active !== undefined && active.jobId === undefined) {
      active.requestState = "ambiguous";
    }
    operation.controller.abort();
  }

  canResume(): boolean {
    return this.resumeState() === "job";
  }

  resumeState(): LiveResumeState {
    const active = this.#activeRequest;
    if (active?.jobId !== undefined && active.statusUrl !== undefined) return "job";
    if (this.#recoveryBlocked) return "blocked";
    if (active?.requestState === "ambiguous") return "request";
    return "none";
  }

  async replan(sessionId: string, userState: UserState): Promise<DemoAnalysis> {
    const session = this.#session;
    if (session === undefined || session.id !== sessionId) {
      throw new LiveExtractionClientError(
        "SESSION_MISSING",
        "The live extraction session is no longer available.",
      );
    }
    return this.#buildAnalysis(session, userState);
  }

  async getEvidence(sessionId: string): Promise<EvidenceResult> {
    const session = this.#session;
    if (session === undefined || session.id !== sessionId) {
      throw new LiveExtractionClientError(
        "SESSION_MISSING",
        "The live extraction session is no longer available.",
      );
    }
    return session.verified.evidence;
  }
}
