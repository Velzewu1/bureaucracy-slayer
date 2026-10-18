import type { ClaudeMessageRequest, ClaudeTransport } from "./types.js";

type AnthropicConstructor = new (
  options: Readonly<{
    apiKey: string;
    defaultHeaders?: Record<string, string>;
    timeout: number;
    maxRetries: number;
  }>,
) => unknown;
type AnthropicClient = Readonly<{
  messages: Readonly<{
    create(
      request: ClaudeMessageRequest,
      options: Readonly<{ timeout: number; maxRetries: number }>,
    ): Promise<unknown>;
  }>;
}>;

export type ClaudeTransportDiagnostic = Readonly<{
  errorClass: string;
  httpStatus: number | null;
  anthropicErrorType: string | null;
  anthropicErrorCode: string | null;
  requestId: string | null;
  message: string;
  potentiallyRetryable: boolean;
}>;

const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 500;
export const DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS = 180_000;
export const DEFAULT_ANTHROPIC_MAX_RETRIES = 0;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function stringProperty(value: unknown, property: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[property];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function recordProperty(value: unknown, property: string): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[property];
  return isRecord(candidate) ? candidate : undefined;
}

function errorClass(error: unknown): string {
  const declaredName = stringProperty(error, "name");
  if (declaredName !== undefined && declaredName !== "Error") return declaredName;
  if (isRecord(error)) {
    const constructor = error["constructor"];
    if (typeof constructor === "function" && constructor.name.length > 0) return constructor.name;
  }
  return declaredName ?? "UnknownError";
}

function sanitizeMessage(value: string, sensitiveValues: readonly string[]): string {
  let sanitized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue.length > 0) sanitized = sanitized.split(sensitiveValue).join("[REDACTED]");
  }
  sanitized = sanitized
    .replace(/\bsk-ant-[a-zA-Z0-9_-]+\b/gu, "[REDACTED]")
    .replace(
      /((?:authorization|x-api-key)["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^"',\s}]+/giu,
      "$1[REDACTED]",
    );
  const codePoints = [...sanitized];
  return codePoints.length <= MAX_DIAGNOSTIC_MESSAGE_LENGTH
    ? sanitized
    : `${codePoints.slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH).join("")}…`;
}

function safeIdentifier(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length === 0 ? null : [...normalized].slice(0, 200).join("");
}

function safeMetadata(value: string | undefined, sensitiveValues: readonly string[]): string | null {
  return value === undefined ? null : safeIdentifier(sanitizeMessage(value, sensitiveValues));
}

function diagnosticFromError(
  error: unknown,
  fallbackMessage: string,
  sensitiveValues: readonly string[],
  potentiallyRetryable: boolean,
): ClaudeTransportDiagnostic {
  const responseBody = recordProperty(error, "error");
  const apiError = recordProperty(responseBody, "error");
  const cause = recordProperty(error, "cause");
  const primaryMessage = stringProperty(error, "message") ?? stringProperty(apiError, "message") ?? fallbackMessage;
  const causeMessage = stringProperty(cause, "message");
  const combinedMessage =
    causeMessage === undefined || causeMessage === primaryMessage
      ? primaryMessage
      : `${primaryMessage} Cause: ${causeMessage}`;

  return {
    errorClass:
      safeMetadata(
        error === undefined ? "ClaudeTransportError" : errorClass(error),
        sensitiveValues,
      ) ?? "UnknownError",
    httpStatus: statusFromError(error) ?? null,
    anthropicErrorType: safeMetadata(
      stringProperty(error, "type") ?? stringProperty(apiError, "type"),
      sensitiveValues,
    ),
    anthropicErrorCode: safeMetadata(
      stringProperty(error, "code") ?? stringProperty(apiError, "code") ?? stringProperty(cause, "code"),
      sensitiveValues,
    ),
    requestId: safeMetadata(
      stringProperty(error, "requestID") ??
        stringProperty(error, "requestId") ??
        stringProperty(error, "request_id") ??
        stringProperty(responseBody, "request_id"),
      sensitiveValues,
    ),
    message: sanitizeMessage(combinedMessage, sensitiveValues),
    potentiallyRetryable,
  };
}

export class ClaudeTransportError extends Error {
  readonly retryable: boolean;
  readonly diagnostic: ClaudeTransportDiagnostic;

  constructor(
    message: string,
    retryable: boolean,
    cause?: unknown,
    sensitiveValues: readonly string[] = [],
    potentiallyRetryable = retryable,
  ) {
    super(message, { cause });
    this.name = "ClaudeTransportError";
    this.retryable = retryable;
    this.diagnostic = diagnosticFromError(
      cause,
      message,
      sensitiveValues,
      potentiallyRetryable,
    );
  }
}

function isAnthropicConstructor(value: unknown): value is AnthropicConstructor {
  return typeof value === "function";
}

function isAnthropicClient(value: unknown): value is AnthropicClient {
  if (!isRecord(value)) return false;
  const messages = value["messages"];
  return isRecord(messages) && typeof messages["create"] === "function";
}

function statusFromError(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const status = error["status"];
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function isTransientStatus(status: number | undefined): boolean {
  return status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500);
}

function isPotentiallyRetryable(error: unknown, status: number | undefined): boolean {
  const className = errorClass(error);
  return (
    isTransientStatus(status) ||
    className === "APIConnectionError" ||
    className === "APIConnectionTimeoutError"
  );
}

export type AnthropicTransportOptions = Readonly<{
  apiKey?: string;
  environment?: Readonly<Record<string, string | undefined>>;
  requestTimeoutMs?: number;
  maxRetries?: number;
}>;

/** Loads the official SDK only when a live transport is requested. */
export async function createAnthropicTransport(
  options: AnthropicTransportOptions = {},
): Promise<ClaudeTransport> {
  const environment = options.environment ?? process.env;
  const apiKey = options.apiKey?.trim() || environment["ANTHROPIC_API_KEY"]?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new ClaudeTransportError("ANTHROPIC_API_KEY is required for live extraction.", false);
  }
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_ANTHROPIC_MAX_RETRIES;
  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs <= 0 ||
    requestTimeoutMs > DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS
  ) {
    throw new ClaudeTransportError(
      "The Anthropic request timeout must be a positive integer no greater than 180 seconds.",
      false,
    );
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 1) {
    throw new ClaudeTransportError(
      "The Anthropic SDK retry count must be zero or one.",
      false,
    );
  }

  const packageSpecifier: string = "@anthropic-ai/sdk";
  let sdkModule: unknown;
  try {
    sdkModule = await import(packageSpecifier);
  } catch (error) {
    throw new ClaudeTransportError("The official Anthropic TypeScript SDK is unavailable.", false, error);
  }
  if (!isRecord(sdkModule) || !isAnthropicConstructor(sdkModule["default"])) {
    throw new ClaudeTransportError("The Anthropic SDK did not expose its expected client constructor.", false);
  }

  let client: unknown;
  try {
    const workspaceId = environment["ANTHROPIC_WORKSPACE_ID"]?.trim();

    client = new sdkModule.default({
      apiKey,
      timeout: requestTimeoutMs,
      maxRetries,
      ...(workspaceId
        ? {
            defaultHeaders: {
              "anthropic-workspace-id": workspaceId,
            },
          }
        : {}),
    });
  } catch (error) {
    throw new ClaudeTransportError("The Anthropic SDK client could not be initialized.", false, error);
  }
  if (!isAnthropicClient(client)) {
    throw new ClaudeTransportError("The Anthropic SDK client did not expose messages.create.", false);
  }

  return {
    async createMessage(
      request: ClaudeMessageRequest,
      requestOptions,
    ): Promise<unknown> {
      const effectiveTimeoutMs = requestOptions?.timeoutMs ?? requestTimeoutMs;
      if (
        !Number.isInteger(effectiveTimeoutMs) ||
        effectiveTimeoutMs <= 0 ||
        effectiveTimeoutMs > requestTimeoutMs
      ) {
        throw new ClaudeTransportError(
          "The per-request Anthropic timeout must be positive and within the configured bound.",
          false,
        );
      }
      try {
        return await client.messages.create(request, {
          timeout: effectiveTimeoutMs,
          maxRetries,
        });
      } catch (error) {
        const status = statusFromError(error);
        throw new ClaudeTransportError(
          "The Claude structured extraction request failed.",
          isTransientStatus(status),
          error,
          [apiKey],
          isPotentiallyRetryable(error, status),
        );
      }
    },
  };
}

