import { existsSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LIVE_EXTRACTION_MAX_REQUEST_BODY_BYTES,
  LIVE_EXTRACTION_LEGACY_GOAL,
  LIVE_EXTRACTION_POLL_INTERVAL_MS,
  LIVE_EXTRACTION_START_ROUTE,
  LiveExtractionErrorResponseSchema,
  LiveExtractionJobIdSchema,
  LiveExtractionJobStatusSchema,
  LiveExtractionStartRequestSchema,
  LiveExtractionStartResponseSchema,
  type LiveExtractionFailure,
} from "../orchestration/live-extraction-contract.js";
import {
  LiveExtractionJobManager,
  type LiveExtractionJobManagerOptions,
} from "../orchestration/live-extraction-job-manager.js";
import {
  createLiveExtractionRunner,
  LIVE_EXTRACTION_API_HOST,
  LIVE_EXTRACTION_API_PORT,
  LIVE_EXTRACTION_UI_ORIGIN,
} from "../orchestration/live-extraction-pipeline.js";

type BodyReadOutcome =
  | Readonly<{ kind: "body"; text: string }>
  | Readonly<{ kind: "too_large" }>;

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function requestFailure(
  code: LiveExtractionFailure["code"],
  message: string,
): LiveExtractionFailure {
  return {
    code,
    stage: "request",
    message,
    retryable: false,
    issueCodes: [],
  };
}

function setResponseHeaders(response: ServerResponse): void {
  response.setHeader("Content-Type", "application/json");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  setResponseHeaders(response);
  response.statusCode = status;
  response.end(JSON.stringify(body));
}

function sendError(
  response: ServerResponse,
  status: number,
  failure: LiveExtractionFailure,
): void {
  sendJson(
    response,
    status,
    LiveExtractionErrorResponseSchema.parse({
      schemaVersion: 1,
      error: failure,
    }),
  );
}

function validContentType(request: IncomingMessage): boolean {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string") return false;
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function declaredBodyTooLarge(request: IncomingMessage): boolean {
  const contentLength = request.headers["content-length"];
  if (contentLength === undefined) return false;
  if (!/^\d+$/u.test(contentLength)) return false;
  return Number(contentLength) > LIVE_EXTRACTION_MAX_REQUEST_BODY_BYTES;
}

async function readBoundedBody(request: IncomingMessage): Promise<BodyReadOutcome> {
  if (declaredBodyTooLarge(request)) {
    request.resume();
    return { kind: "too_large" };
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > LIVE_EXTRACTION_MAX_REQUEST_BODY_BYTES) {
      request.resume();
      return { kind: "too_large" };
    }
    chunks.push(bytes);
  }
  return { kind: "body", text: Buffer.concat(chunks).toString("utf8") };
}

function unsupportedActionFrom(input: unknown): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  const action = Reflect.get(input, "action");
  return typeof action === "string" && action !== "start_live_extraction";
}

async function handleStart(
  request: IncomingMessage,
  response: ServerResponse,
  manager: LiveExtractionJobManager,
): Promise<void> {
  if (!validContentType(request)) {
    request.resume();
    sendError(
      response,
      415,
      requestFailure("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json."),
    );
    return;
  }

  const body = await readBoundedBody(request);
  if (body.kind === "too_large") {
    sendError(
      response,
      413,
      requestFailure(
        "REQUEST_TOO_LARGE",
        `The request body exceeds ${LIVE_EXTRACTION_MAX_REQUEST_BODY_BYTES.toLocaleString("en-US")} bytes.`,
      ),
    );
    return;
  }

  let input: unknown;
  try {
    input = JSON.parse(body.text);
  } catch {
    sendError(
      response,
      400,
      requestFailure("REQUEST_INVALID", "The request body must contain valid JSON."),
    );
    return;
  }

  const parsed = LiveExtractionStartRequestSchema.safeParse(input);
  if (!parsed.success) {
    sendError(
      response,
      400,
      requestFailure(
        unsupportedActionFrom(input) ? "UNSUPPORTED_ACTION" : "REQUEST_INVALID",
        unsupportedActionFrom(input)
          ? "The requested action is unsupported."
          : "The start request did not match the strict API contract.",
      ),
    );
    return;
  }

  const goal =
    parsed.data.schemaVersion === 1 ? LIVE_EXTRACTION_LEGACY_GOAL : parsed.data.goal;
  const outcome = manager.start(parsed.data.requestId, goal);
  if (!outcome.ok) {
    sendError(response, 409, outcome.failure);
    return;
  }
  const result = LiveExtractionStartResponseSchema.parse(outcome.response);
  response.setHeader("Location", result.statusUrl);
  response.setHeader("Retry-After", String(LIVE_EXTRACTION_POLL_INTERVAL_MS / 1_000));
  sendJson(response, 202, result);
}

function handleStatus(
  response: ServerResponse,
  manager: LiveExtractionJobManager,
  jobIdInput: string,
): void {
  const jobId = LiveExtractionJobIdSchema.safeParse(jobIdInput);
  if (!jobId.success) {
    sendError(
      response,
      400,
      requestFailure("REQUEST_INVALID", "The job ID is invalid."),
    );
    return;
  }
  const result = manager.get(jobId.data);
  if (result.kind === "expired") {
    sendError(
      response,
      410,
      requestFailure("JOB_EXPIRED", "The retained job result has expired."),
    );
    return;
  }
  if (result.kind === "missing") {
    sendError(
      response,
      404,
      requestFailure("JOB_NOT_FOUND", "The requested job was not found."),
    );
    return;
  }
  sendJson(response, 200, LiveExtractionJobStatusSchema.parse(result.status));
}

function pathJobId(pathname: string): string | undefined {
  const prefix = `${LIVE_EXTRACTION_START_ROUTE}/`;
  if (!pathname.startsWith(prefix)) return undefined;
  return pathname.slice(prefix.length);
}

function allowOnly(response: ServerResponse, method: "GET" | "POST"): void {
  response.setHeader("Allow", method);
  sendError(
    response,
    405,
    requestFailure("UNSUPPORTED_ACTION", "The HTTP method is unsupported for this resource."),
  );
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  manager: LiveExtractionJobManager,
): Promise<void> {
  let pathname: string;
  try {
    pathname = new URL(request.url ?? "", `http://${LIVE_EXTRACTION_API_HOST}`).pathname;
  } catch {
    sendError(
      response,
      400,
      requestFailure("REQUEST_INVALID", "The request URL is invalid."),
    );
    return;
  }

  const origin = request.headers.origin;
  const sameOriginPollingRequest =
    origin === undefined &&
    request.headers["sec-fetch-site"] === "same-origin" &&
    request.method === "GET" &&
    pathJobId(pathname) !== undefined;
  if (origin !== LIVE_EXTRACTION_UI_ORIGIN && !sameOriginPollingRequest) {
    request.resume();
    sendError(
      response,
      400,
      requestFailure("REQUEST_INVALID", "The request Origin is missing or invalid."),
    );
    return;
  }

  if (pathname === LIVE_EXTRACTION_START_ROUTE) {
    if (request.method !== "POST") {
      request.resume();
      allowOnly(response, "POST");
      return;
    }
    await handleStart(request, response, manager);
    return;
  }

  const jobId = pathJobId(pathname);
  if (jobId !== undefined) {
    if (request.method !== "GET") {
      request.resume();
      allowOnly(response, "GET");
      return;
    }
    request.resume();
    handleStatus(response, manager, jobId);
    return;
  }

  request.resume();
  sendError(
    response,
    404,
    requestFailure("JOB_NOT_FOUND", "The requested API resource was not found."),
  );
}

export function createLiveExtractionServer(
  manager: LiveExtractionJobManager,
): Server {
  const server = createServer((request, response) => {
    void handleRequest(request, response, manager).catch(() => {
      if (!response.headersSent) {
        sendError(
          response,
          500,
          {
            code: "INTERNAL_ERROR",
            stage: "internal",
            message: "The API request failed unexpectedly.",
            retryable: false,
            issueCodes: [],
          },
        );
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

export async function listenLiveExtractionServer(
  server: Server,
  port = LIVE_EXTRACTION_API_PORT,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, LIVE_EXTRACTION_API_HOST);
  });
}

export function createDefaultLiveExtractionJobManager(
  options: Omit<LiveExtractionJobManagerOptions, "runner"> = {},
): LiveExtractionJobManager {
  const environment = process.env;
  return new LiveExtractionJobManager({
    ...options,
    portalIdentity: environment["COLLECTOR_TEST_URL"] ?? "",
    runner: createLiveExtractionRunner({
      environment,
      allowedPortalUrl: environment["COLLECTOR_TEST_URL"] ?? "",
    }),
  });
}

export async function main(): Promise<void> {
  const envPath = join(PROJECT_ROOT, ".env");
  if (existsSync(envPath)) loadEnvFile(envPath);
  const server = createLiveExtractionServer(createDefaultLiveExtractionJobManager());
  await listenLiveExtractionServer(server);
  process.stdout.write(
    `Live extraction API listening on http://${LIVE_EXTRACTION_API_HOST}:${LIVE_EXTRACTION_API_PORT}\n`,
  );
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void main().catch(() => {
    process.stderr.write("Live extraction API failed to start.\n");
    process.exitCode = 1;
  });
}
