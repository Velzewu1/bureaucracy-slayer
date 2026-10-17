import { z } from "zod";

type ResponseParseSuccess = Readonly<{ ok: true; value: unknown }>;
type ResponseParseFailure = Readonly<{ ok: false; issues: readonly string[] }>;
export type ResponseParseOutcome = ResponseParseSuccess | ResponseParseFailure;

const ResponseProjectionSchema = z
  .object({
    stopReason: z.string().nullable(),
    content: z.array(z.unknown()),
  })
  .strict();

const TextBlockProjectionSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseClaudeStructuredResponse(input: unknown): ResponseParseOutcome {
  if (!isRecord(input)) return { ok: false, issues: ["Claude response was not an object."] };

  const responseResult = ResponseProjectionSchema.safeParse({
    stopReason: input["stop_reason"],
    content: input["content"],
  });
  if (!responseResult.success) {
    return { ok: false, issues: responseResult.error.issues.map((issue) => issue.message) };
  }
  if (responseResult.data.stopReason !== "end_turn") {
    return {
      ok: false,
      issues: [`Claude response stopped with ${responseResult.data.stopReason ?? "no stop reason"}.`],
    };
  }
  if (responseResult.data.content.length !== 1) {
    return { ok: false, issues: ["Claude response must contain exactly one structured text block."] };
  }

  const block = responseResult.data.content[0];
  if (!isRecord(block)) return { ok: false, issues: ["Claude content block was not an object."] };
  const blockResult = TextBlockProjectionSchema.safeParse({ type: block["type"], text: block["text"] });
  if (!blockResult.success) {
    return { ok: false, issues: blockResult.error.issues.map((issue) => issue.message) };
  }

  try {
    const value: unknown = JSON.parse(blockResult.data.text);
    return { ok: true, value };
  } catch {
    return { ok: false, issues: ["Claude structured text was not valid JSON."] };
  }
}

