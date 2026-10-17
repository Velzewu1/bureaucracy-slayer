import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  LIVE_EXTRACTION_MAX_REQUEST_BODY_BYTES,
  LIVE_EXTRACTION_START_ROUTE,
  LiveExtractionJobIdSchema,
  LiveExtractionJobStatusSchema,
  LiveExtractionStartRequestSchema,
  type LiveExtractionJobStatus,
} from "../../../src/orchestration/live-extraction-contract.js";
import {
  createLiveErrorResponseFixture,
  createLiveJobTimelineFixture,
  createLiveStartResponseFixture,
  LIVE_TEST_JOB_ID,
} from "./contract-fixtures.js";

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
} as const;

const RUNNING_PHASE_ORDER = [
  "collecting",
  "selecting_sources",
  "extracting_policy",
  "mapping_procedure",
  "validating",
] as const;

type MockRequestRecord = Readonly<{
  method: string;
  url: string;
}>;

export type LiveMockApi = Readonly<{
  origin: string;
  requests: readonly MockRequestRecord[];
  physicalJobStarts: number;
  close: () => Promise<void>;
}>;

type StartLiveMockApiOptions = Readonly<{
  timeline?: readonly LiveExtractionJobStatus[];
  rawTimeline?: readonly unknown[];
  expiredJobIds?: readonly string[];
  port?: number;
}>;

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, { ...JSON_HEADERS, ...extraHeaders });
  response.end(JSON.stringify(body));
}

async function readBoundedBody(
  request: IncomingMessage,
): Promise<Readonly<{ tooLarge: boolean; text: string }>> {
  let bytes = 0;
  let tooLarge = false;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > LIVE_EXTRACTION_MAX_REQUEST_BODY_BYTES) {
      tooLarge = true;
    } else {
      chunks.push(buffer);
    }
  }
  return { tooLarge, text: tooLarge ? "" : Buffer.concat(chunks).toString("utf8") };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSameJob(
  first: LiveExtractionJobStatus,
  candidate: LiveExtractionJobStatus,
): void {
  if (candidate.jobId !== first.jobId || candidate.requestId !== first.requestId) {
    throw new Error("A mock live job timeline cannot change job or request identity.");
  }
}

export function assertValidLiveJobTimeline(
  inputs: readonly LiveExtractionJobStatus[],
): readonly LiveExtractionJobStatus[] {
  if (inputs.length === 0) throw new Error("A mock live job timeline must not be empty.");
  const statuses = inputs.map((input) => LiveExtractionJobStatusSchema.parse(input));
  const first = statuses[0];
  if (first === undefined) throw new Error("A mock live job timeline must not be empty.");

  let terminalState: "succeeded" | "failed" | undefined;
  let terminalValue: string | undefined;
  let previousUpdatedAt = "";
  let previousPhaseIndex = -1;
  let hasStarted = false;
  for (const status of statuses) {
    assertSameJob(first, status);
    if (status.updatedAt < previousUpdatedAt) {
      throw new Error("A mock live job timeline cannot move updatedAt backwards.");
    }
    previousUpdatedAt = status.updatedAt;

    if (terminalState !== undefined) {
      if (status.state !== terminalState) {
        throw new Error("A mock live job timeline cannot transition after a terminal state.");
      }
      if (JSON.stringify(status) !== terminalValue) {
        throw new Error("A mock live job timeline cannot mutate a terminal state.");
      }
    }
    if (status.state === "queued") {
      if (hasStarted) throw new Error("A mock live job timeline cannot return to queued.");
      continue;
    }
    hasStarted = true;
    if (status.state === "running") {
      const phaseIndex = RUNNING_PHASE_ORDER.indexOf(status.phase);
      if (phaseIndex < previousPhaseIndex) {
        throw new Error("A mock live job timeline cannot move a running phase backwards.");
      }
      previousPhaseIndex = phaseIndex;
      continue;
    }
    terminalState = status.state;
    terminalValue = JSON.stringify(status);
  }
  return statuses;
}

function contentTypeIsJson(request: IncomingMessage): boolean {
  return request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json";
}

export async function startLiveMockApi(
  options: StartLiveMockApiOptions = {},
): Promise<LiveMockApi> {
  if (options.timeline !== undefined && options.rawTimeline !== undefined) {
    throw new Error("Choose either a validated timeline or a raw tamper-test timeline.");
  }
  const timeline: readonly unknown[] = options.rawTimeline ??
    assertValidLiveJobTimeline(options.timeline ?? createLiveJobTimelineFixture());
  if (timeline.length === 0) throw new Error("A mock live job timeline must not be empty.");
  const requests: MockRequestRecord[] = [];
  const expiredJobIds = new Set(options.expiredJobIds ?? []);
  let acceptedRequestId: string | undefined;
  let statusIndex = 0;
  let physicalJobStarts = 0;

  const server: Server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "UNKNOWN";
      const url = request.url ?? "/";
      requests.push({ method, url });

      if (url === LIVE_EXTRACTION_START_ROUTE && method === "POST") {
        if (!contentTypeIsJson(request)) {
          writeJson(response, 415, createLiveErrorResponseFixture("UNSUPPORTED_MEDIA_TYPE"));
          return;
        }
        const body = await readBoundedBody(request);
        if (body.tooLarge) {
          writeJson(response, 413, createLiveErrorResponseFixture("REQUEST_TOO_LARGE"));
          return;
        }
        let input: unknown;
        try {
          input = JSON.parse(body.text);
        } catch {
          writeJson(response, 400, createLiveErrorResponseFixture("REQUEST_INVALID"));
          return;
        }
        const parsed = LiveExtractionStartRequestSchema.safeParse(input);
        if (!parsed.success) {
          const code = isRecord(input) && input.action !== undefined &&
              input.action !== "start_live_extraction"
            ? "UNSUPPORTED_ACTION"
            : "REQUEST_INVALID";
          writeJson(response, 400, createLiveErrorResponseFixture(code));
          return;
        }
        if (acceptedRequestId !== undefined && parsed.data.requestId !== acceptedRequestId) {
          writeJson(response, 409, createLiveErrorResponseFixture("JOB_ALREADY_RUNNING"));
          return;
        }
        if (acceptedRequestId === undefined) {
          acceptedRequestId = parsed.data.requestId;
          physicalJobStarts += 1;
        }
        const start = createLiveStartResponseFixture();
        writeJson(response, 202, start, {
          location: start.statusUrl,
          "retry-after": "1",
        });
        return;
      }

      const statusPrefix = `${LIVE_EXTRACTION_START_ROUTE}/`;
      if (url.startsWith(statusPrefix) && method === "GET") {
        const jobId = url.slice(statusPrefix.length);
        if (!LiveExtractionJobIdSchema.safeParse(jobId).success) {
          writeJson(response, 400, createLiveErrorResponseFixture("REQUEST_INVALID"));
          return;
        }
        if (expiredJobIds.has(jobId)) {
          writeJson(response, 410, createLiveErrorResponseFixture("JOB_EXPIRED"));
          return;
        }
        if (jobId !== LIVE_TEST_JOB_ID || acceptedRequestId === undefined) {
          writeJson(response, 404, createLiveErrorResponseFixture("JOB_NOT_FOUND"));
          return;
        }
        const status = timeline[Math.min(statusIndex, timeline.length - 1)];
        if (status === undefined) throw new Error("The validated mock timeline unexpectedly became empty.");
        statusIndex += 1;
        writeJson(
          response,
          200,
          isRecord(status) ? { ...status, requestId: acceptedRequestId } : status,
        );
        return;
      }

      if (url === LIVE_EXTRACTION_START_ROUTE || url.startsWith(`${LIVE_EXTRACTION_START_ROUTE}/`)) {
        writeJson(response, 405, createLiveErrorResponseFixture("UNSUPPORTED_ACTION"), {
          allow: url === LIVE_EXTRACTION_START_ROUTE ? "POST" : "GET",
        });
        return;
      }
      writeJson(response, 404, createLiveErrorResponseFixture("JOB_NOT_FOUND"));
    })().catch(() => {
      if (!response.headersSent) {
        writeJson(response, 500, {
          schemaVersion: 1,
          error: {
            code: "INTERNAL_ERROR",
            stage: "internal",
            message: "The mock live extraction request failed.",
            retryable: false,
            issueCodes: [],
          },
        });
      } else {
        response.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the mock live API to have a TCP address.");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    get physicalJobStarts() {
      return physicalJobStarts;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}
