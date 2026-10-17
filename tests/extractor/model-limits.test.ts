import { describe, expect, it } from "vitest";

import {
  anthropicModelOutputTokenLimit,
  parseAnthropicMaxTokens,
} from "../../src/extractor/index.js";

describe("Anthropic output-token configuration", () => {
  it("accepts the configured live limit for Haiku 4.5", () => {
    expect(parseAnthropicMaxTokens("16000", "claude-haiku-4-5")).toEqual({
      ok: true,
      value: 16_000,
      modelLimit: 64_000,
    });
    expect(anthropicModelOutputTokenLimit("claude-haiku-4-5-20251001")).toBe(64_000);
  });

  it("rejects values above the selected model's supported output limit", () => {
    const outcome = parseAnthropicMaxTokens("64001", "claude-haiku-4-5");
    expect(outcome).toMatchObject({ ok: false });
    if (outcome.ok) return;
    expect(outcome.message).toContain("exceeds");
    expect(outcome.message).toContain("64000-token output limit");
  });

  it("rejects missing, malformed, and too-small values", () => {
    expect(parseAnthropicMaxTokens(undefined, "claude-haiku-4-5")).toMatchObject({ ok: false });
    expect(parseAnthropicMaxTokens("16k", "claude-haiku-4-5")).toMatchObject({ ok: false });
    expect(parseAnthropicMaxTokens("255", "claude-haiku-4-5")).toMatchObject({ ok: false });
  });

  it("fails closed for models without a verified local limit", () => {
    const outcome = parseAnthropicMaxTokens("16000", "claude-unknown-model");
    expect(outcome).toMatchObject({ ok: false });
    if (outcome.ok) return;
    expect(outcome.message).toContain("No verified output-token limit");
  });
});
