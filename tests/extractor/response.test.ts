import { describe, expect, it } from "vitest";

import { parseClaudeStructuredResponse } from "../../src/extractor/index.js";

function response(
  content: readonly unknown[],
  stopReason = "end_turn",
  usage: Readonly<{ input_tokens: number; output_tokens: number }> = {
    input_tokens: 321,
    output_tokens: 45,
  },
): unknown {
  return { stop_reason: stopReason, usage, content };
}

describe("Claude structured-response diagnostics", () => {
  it("parses one complete structured text block and reports safe metadata", () => {
    const outcome = parseClaudeStructuredResponse(
      response([{ type: "text", text: '{"answer":true}' }]),
      16_000,
    );

    expect(outcome).toEqual({
      ok: true,
      value: { answer: true },
      metadata: {
        stopReason: "end_turn",
        contentBlockCount: 1,
        contentBlockTypes: ["text"],
        textBlockCount: 1,
        inputTokens: 321,
        outputTokens: 45,
        configuredMaxTokens: 16_000,
        structuredJsonComplete: true,
      },
    });
  });

  it("rejects empty content", () => {
    const outcome = parseClaudeStructuredResponse(response([]), 16_000);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toEqual(["Claude response content was empty."]);
    expect(outcome.metadata).toMatchObject({
      contentBlockCount: 0,
      textBlockCount: 0,
      structuredJsonComplete: false,
    });
  });

  it("accepts documented thinking companions without concatenating them", () => {
    const outcome = parseClaudeStructuredResponse(
      response([
        { type: "thinking", thinking: "not inspected" },
        { type: "redacted_thinking", data: "not inspected" },
        { type: "text", text: '{"answer":true}' },
      ]),
      16_000,
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.metadata).toMatchObject({
      contentBlockCount: 3,
      contentBlockTypes: ["thinking", "redacted_thinking", "text"],
      textBlockCount: 1,
      structuredJsonComplete: true,
    });
  });

  it("rejects multiple text blocks instead of concatenating JSON", () => {
    const outcome = parseClaudeStructuredResponse(
      response([
        { type: "text", text: '{"first":true}' },
        { type: "text", text: '{"second":true}' },
      ]),
      16_000,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toEqual([
      "Claude structured response must contain exactly one text block; received 2.",
    ]);
    expect(outcome.metadata.textBlockCount).toBe(2);
  });

  it("rejects non-text, non-thinking blocks", () => {
    const outcome = parseClaudeStructuredResponse(
      response([
        { type: "tool_use", id: "tool_1", name: "unexpected", input: {} },
        { type: "text", text: '{"answer":true}' },
      ]),
      16_000,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toEqual([
      "Claude structured response contained unsupported content block types: tool_use.",
    ]);
    expect(outcome.metadata.contentBlockTypes).toEqual(["tool_use", "text"]);
  });

  it("reports configured and observed token counts for max_tokens truncation", () => {
    const sensitiveText = "fictional-sensitive-user-data";
    const outcome = parseClaudeStructuredResponse(
      response(
        [{ type: "text", text: sensitiveText }],
        "max_tokens",
        { input_tokens: 500, output_tokens: 16_000 },
      ),
      16_000,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toEqual([
      "Claude reached max_tokens=16000; the structured response was incomplete. " +
        "The API reported 16000 generated output tokens.",
    ]);
    expect(outcome.metadata).toMatchObject({
      stopReason: "max_tokens",
      inputTokens: 500,
      outputTokens: 16_000,
      configuredMaxTokens: 16_000,
      structuredJsonComplete: false,
    });
    expect(JSON.stringify(outcome)).not.toContain(sensitiveText);
  });

  it("rejects unexpected stop reasons even when the text is valid JSON", () => {
    const outcome = parseClaudeStructuredResponse(
      response([{ type: "text", text: '{"answer":true}' }], "pause_turn"),
      16_000,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues).toEqual(["Claude response stopped with pause_turn."]);
    expect(outcome.metadata).toMatchObject({
      stopReason: "pause_turn",
      structuredJsonComplete: false,
    });
  });

  it("does not retain response text in safe metadata diagnostics", () => {
    const sensitiveText = "fictional-sensitive-user-data";
    const outcome = parseClaudeStructuredResponse(
      response([{ type: "text", text: sensitiveText }]),
      16_000,
    );

    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(sensitiveText);
  });
});
