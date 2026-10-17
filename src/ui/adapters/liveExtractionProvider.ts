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
  LiveExtractionErrorResponseSchema,
  LiveExtractionJobStatusSchema,
  LiveExtractionStartRequestSchema,
  LiveExtractionStartResponseSchema,
  type LiveExtractionClientStopReason,
  type LiveExtractionFailureCode,
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

export type LiveExtractionProviderOptions = Readonly<{
  fetch?: FetchImplementation;
  generateRequestId?: () => LiveExtractionRequestId;
  now?: () => string;
  wait?: WaitImplementation;
}>;

type ActiveRequest = {
  requestId: LiveExtractionRequestId;
  jobId?: string;
  statusUrl?: string;
};

type Operation = {
  controller: AbortController;
  stopReason: LiveExtractionClientStopReason | null;
};

type LiveSession = Readonly<{
  id: string;
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
  readonly #wait: WaitImplementation;
  readonly #sessions = new Map<string, LiveSession>();
  #activeRequest: ActiveRequest | undefined;
  #operation: Operation | undefined;
  #inFlight: Promise<DemoAnalysis> | undefined;

  constructor(options: LiveExtractionProviderOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#generateRequestId = options.generateRequestId ?? generateRequestId;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#wait = options.wait ?? wait;
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
      throw new LiveExtractionClientError(
        "MALFORMED_RESPONSE",
        "The live extraction start response did not match the frozen API contract.",
      );
    }
    active.jobId = parsed.data.jobId;
    active.statusUrl = parsed.data.statusUrl;
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
      portalName: "Northstar Mock Bank (live extraction)",
      portalUrl: artifact.portalUrl,
      snapshot: artifact.sourceSnapshot,
      model: artifact.procedureModel,
      evidence,
      evaluation,
      plan,
      userState,
      semanticAuditFindings: semanticAudit.findings,
      source: {
        label: "Live Sonnet extraction",
        extractionPreviouslyCompleted: false,
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

    const active =
      this.#activeRequest ??
      { requestId: this.#generateRequestId() };
    this.#activeRequest = active;
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
        this.#activeRequest = undefined;
        const heading = failureHeadings[status.error.code];
        throw new LiveExtractionClientError(
          status.error.code,
          heading === undefined ? status.error.message : `${heading} ${status.error.message}`,
        );
      }

      this.#activeRequest = undefined;
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
        verified,
      };
      this.#sessions.set(session.id, session);
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
        this.#activeRequest = undefined;
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
    operation.controller.abort();
  }

  canResume(): boolean {
    return (
      this.#activeRequest?.jobId !== undefined &&
      this.#activeRequest.statusUrl !== undefined
    );
  }

  async replan(sessionId: string, userState: UserState): Promise<DemoAnalysis> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new LiveExtractionClientError(
        "SESSION_MISSING",
        "The live extraction session is no longer available.",
      );
    }
    return this.#buildAnalysis(session, userState);
  }

  async getEvidence(sessionId: string): Promise<EvidenceResult> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new LiveExtractionClientError(
        "SESSION_MISSING",
        "The live extraction session is no longer available.",
      );
    }
    return session.verified.evidence;
  }
}
