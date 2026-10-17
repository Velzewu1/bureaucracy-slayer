import type { ClaudeMessageRequest, ClaudeTransport } from "./types.js";

type AnthropicConstructor = new (options: Readonly<{ apiKey: string }>) => unknown;
type AnthropicClient = Readonly<{
  messages: Readonly<{
    create(request: ClaudeMessageRequest): Promise<unknown>;
  }>;
}>;

export class ClaudeTransportError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, cause?: unknown) {
    super(message, { cause });
    this.name = "ClaudeTransportError";
    this.retryable = retryable;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
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

export type AnthropicTransportOptions = Readonly<{
  apiKey?: string;
  environment?: Readonly<Record<string, string | undefined>>;
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
    client = new sdkModule.default({ apiKey });
  } catch (error) {
    throw new ClaudeTransportError("The Anthropic SDK client could not be initialized.", false, error);
  }
  if (!isAnthropicClient(client)) {
    throw new ClaudeTransportError("The Anthropic SDK client did not expose messages.create.", false);
  }

  return {
    async createMessage(request: ClaudeMessageRequest): Promise<unknown> {
      try {
        return await client.messages.create(request);
      } catch (error) {
        throw new ClaudeTransportError(
          "The Claude structured extraction request failed.",
          isTransientStatus(statusFromError(error)),
          error,
        );
      }
    },
  };
}

