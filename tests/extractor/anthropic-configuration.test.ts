import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createAnthropicTransport,
  DEFAULT_ANTHROPIC_MAX_RETRIES,
  DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS,
} from "../../src/extractor/anthropic.js";

const sdkCapture = vi.hoisted(() => ({
  constructorOptions: [] as Array<Record<string, unknown>>,
  requests: [] as unknown[],
  requestOptions: [] as unknown[],
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropic {
    readonly messages = {
      create: (request: unknown, options: unknown): Promise<unknown> => {
        sdkCapture.requests.push(request);
        sdkCapture.requestOptions.push(options);
        return Promise.resolve({ id: "message_test" });
      },
    };

    constructor(options: Record<string, unknown>) {
      sdkCapture.constructorOptions.push(options);
    }
  },
}));

const request = {
  model: "claude-sonnet-test",
  max_tokens: 1_000,
  system: "test",
  messages: [{ role: "user" as const, content: "test" }] as const,
  output_config: {
    format: {
      type: "json_schema" as const,
      schema: {},
    },
  },
};

beforeEach(() => {
  sdkCapture.constructorOptions.length = 0;
  sdkCapture.requests.length = 0;
  sdkCapture.requestOptions.length = 0;
});

describe("Anthropic transport bounds", () => {
  it("configures an explicit request timeout and disables SDK retries by default", async () => {
    const transport = await createAnthropicTransport({
      apiKey: "sk-ant-test-secret",
      environment: {},
    });
    await transport.createMessage(request);

    expect(sdkCapture.constructorOptions).toEqual([
      {
        apiKey: "sk-ant-test-secret",
        timeout: DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS,
        maxRetries: DEFAULT_ANTHROPIC_MAX_RETRIES,
      },
    ]);
    expect(DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS).toBe(180_000);
    expect(DEFAULT_ANTHROPIC_MAX_RETRIES).toBe(0);
    expect(sdkCapture.requests).toHaveLength(1);
    expect(sdkCapture.requestOptions).toEqual([
      {
        timeout: DEFAULT_ANTHROPIC_REQUEST_TIMEOUT_MS,
        maxRetries: DEFAULT_ANTHROPIC_MAX_RETRIES,
      },
    ]);
  });

  it("passes a stricter bounded timeout and explicit zero retries", async () => {
    const transport = await createAnthropicTransport({
      apiKey: "sk-ant-test-secret",
      environment: {},
      requestTimeoutMs: 90_000,
      maxRetries: 0,
    });
    await transport.createMessage(request, { timeoutMs: 45_000 });

    expect(sdkCapture.constructorOptions[0]).toMatchObject({
      timeout: 90_000,
      maxRetries: 0,
    });
    expect(sdkCapture.requestOptions[0]).toEqual({
      timeout: 45_000,
      maxRetries: 0,
    });
  });

  it("rejects unbounded timeouts and retry counts before creating a client", async () => {
    await expect(
      createAnthropicTransport({
        apiKey: "sk-ant-test-secret",
        environment: {},
        requestTimeoutMs: 180_001,
      }),
    ).rejects.toThrow("no greater than 180 seconds");
    await expect(
      createAnthropicTransport({
        apiKey: "sk-ant-test-secret",
        environment: {},
        maxRetries: 2,
      }),
    ).rejects.toThrow("must be zero or one");
    expect(sdkCapture.constructorOptions).toHaveLength(0);
  });

  it("rejects a per-request timeout above the configured transport bound", async () => {
    const transport = await createAnthropicTransport({
      apiKey: "sk-ant-test-secret",
      environment: {},
      requestTimeoutMs: 90_000,
      maxRetries: 0,
    });

    await expect(
      transport.createMessage(request, { timeoutMs: 90_001 }),
    ).rejects.toThrow("within the configured bound");
    expect(sdkCapture.requests).toHaveLength(0);
  });
});
