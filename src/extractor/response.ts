import { z } from "zod";

export type ClaudeResponseMetadata = Readonly<{
  stopReason: string | null;
  contentBlockCount: number | null;
  contentBlockTypes: readonly string[];
  textBlockCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  configuredMaxTokens: number | null;
  structuredJsonComplete: boolean;
}>;

type ResponseParseSuccess = Readonly<{
  ok: true;
  value: unknown;
  metadata: ClaudeResponseMetadata;
}>;
type ResponseParseFailure = Readonly<{
  ok: false;
  issues: readonly string[];
  metadata: ClaudeResponseMetadata;
}>;
export type ResponseParseOutcome = ResponseParseSuccess | ResponseParseFailure;

const ResponseProjectionSchema = z
  .object({
    stopReason: z.string().nullable(),
    content: z.array(z.unknown()),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportedTokenCount(
  input: Readonly<Record<string, unknown>>,
  property: "input_tokens" | "output_tokens",
): number | null {
  const usage = input["usage"];
  if (!isRecord(usage)) return null;
  const count = usage[property];
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
}

function blockType(block: unknown): string {
  if (!isRecord(block)) return "unknown";
  const type = block["type"];
  return typeof type === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(type) ? type : "unknown";
}

const KNOWN_STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
  "model_context_window_exceeded",
]);

function stopReason(input: Readonly<Record<string, unknown>>): string | null {
  const value = input["stop_reason"];
  if (value === null) return null;
  return typeof value === "string" && KNOWN_STOP_REASONS.has(value) ? value : "unknown";
}

function responseMetadata(
  input: unknown,
  configuredMaxTokens: number | undefined,
): ClaudeResponseMetadata {
  if (!isRecord(input)) {
    return {
      stopReason: null,
      contentBlockCount: null,
      contentBlockTypes: [],
      textBlockCount: 0,
      inputTokens: null,
      outputTokens: null,
      configuredMaxTokens: configuredMaxTokens ?? null,
      structuredJsonComplete: false,
    };
  }

  const content = Array.isArray(input["content"]) ? input["content"] : null;
  const contentBlockTypes = content?.map(blockType) ?? [];
  return {
    stopReason: stopReason(input),
    contentBlockCount: content?.length ?? null,
    contentBlockTypes,
    textBlockCount: contentBlockTypes.filter((type) => type === "text").length,
    inputTokens: reportedTokenCount(input, "input_tokens"),
    outputTokens: reportedTokenCount(input, "output_tokens"),
    configuredMaxTokens: configuredMaxTokens ?? null,
    structuredJsonComplete: false,
  };
}

function completeMetadata(metadata: ClaudeResponseMetadata): ClaudeResponseMetadata {
  return { ...metadata, structuredJsonComplete: true };
}

/**
 * Parses one grammar-constrained JSON text block. Anthropic may place thinking
 * blocks beside that text; they are never concatenated with or treated as JSON.
 */
export function parseClaudeStructuredResponse(
  input: unknown,
  configuredMaxTokens?: number,
): ResponseParseOutcome {
  const metadata = responseMetadata(input, configuredMaxTokens);
  if (!isRecord(input)) {
    return { ok: false, issues: ["Claude response was not an object."], metadata };
  }

  const responseResult = ResponseProjectionSchema.safeParse({
    stopReason: stopReason(input),
    content: input["content"],
    inputTokens: reportedTokenCount(input, "input_tokens"),
    outputTokens: reportedTokenCount(input, "output_tokens"),
  });
  if (!responseResult.success) {
    return {
      ok: false,
      issues: responseResult.error.issues.map((issue) => issue.message),
      metadata,
    };
  }
  if (responseResult.data.stopReason !== "end_turn") {
    if (responseResult.data.stopReason === "max_tokens") {
      const configuredLimit =
        configuredMaxTokens === undefined
          ? "the configured max_tokens limit"
          : `max_tokens=${configuredMaxTokens}`;
      const reportedTokens =
        responseResult.data.outputTokens === null
          ? ""
          : ` The API reported ${responseResult.data.outputTokens} generated output tokens.`;
      return {
        ok: false,
        issues: [
          `Claude reached ${configuredLimit}; the structured response was incomplete.${reportedTokens}`,
        ],
        metadata,
      };
    }
    return {
      ok: false,
      issues: [`Claude response stopped with ${responseResult.data.stopReason ?? "no stop reason"}.`],
      metadata,
    };
  }

  if (responseResult.data.content.length === 0) {
    return { ok: false, issues: ["Claude response content was empty."], metadata };
  }

  const unsupportedBlockTypes = metadata.contentBlockTypes.filter(
    (type) => type !== "text" && type !== "thinking" && type !== "redacted_thinking",
  );
  if (unsupportedBlockTypes.length > 0) {
    return {
      ok: false,
      issues: [
        `Claude structured response contained unsupported content block types: ${[
          ...new Set(unsupportedBlockTypes),
        ].join(", ")}.`,
      ],
      metadata,
    };
  }

  const textBlocks = responseResult.data.content.filter(
    (block): block is Readonly<Record<string, unknown>> =>
      isRecord(block) && block["type"] === "text",
  );
  if (textBlocks.length !== 1) {
    return {
      ok: false,
      issues: [
        `Claude structured response must contain exactly one text block; received ${textBlocks.length}.`,
      ],
      metadata,
    };
  }

  const text = textBlocks[0]!["text"];
  if (typeof text !== "string") {
    return { ok: false, issues: ["Claude structured text block had no text."], metadata };
  }

  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value, metadata: completeMetadata(metadata) };
  } catch {
    return {
      ok: false,
      issues: ["Claude structured text was not valid JSON."],
      metadata,
    };
  }
}
