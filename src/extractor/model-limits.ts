export type MaxTokensConfiguration =
  | Readonly<{ ok: true; value: number; modelLimit: number }>
  | Readonly<{ ok: false; message: string }>;

const MIN_OUTPUT_TOKENS = 256;

// Keep this fail-closed catalog aligned with Anthropic's model documentation.
// Unknown model IDs require an explicit catalog update instead of an unsafe guess.
const MODEL_OUTPUT_TOKEN_LIMITS: Readonly<Record<string, number>> = {
  "claude-haiku-4-5": 64_000,
  "claude-haiku-4-5-20251001": 64_000,
  "claude-sonnet-4-5": 64_000,
  "claude-sonnet-4-5-20250929": 64_000,
  "claude-opus-4-5": 64_000,
  "claude-opus-4-5-20251101": 64_000,
  "claude-sonnet-4-6": 128_000,
  "claude-opus-4-6": 128_000,
  "claude-opus-4-7": 128_000,
  "claude-opus-4-8": 128_000,
  "claude-haiku-5-5": 128_000,
  "claude-sonnet-5": 128_000,
  "claude-sonnet-5-5": 128_000,
  "claude-opus-5": 128_000,
  "claude-opus-5-5": 128_000,
  "claude-fable-5": 128_000,
  "claude-fable-5-1": 128_000,
  "claude-mythos-5": 128_000,
  "claude-mythos-5-1": 128_000,
  "claude-mythos-preview": 128_000,
};

export function anthropicModelOutputTokenLimit(model: string): number | undefined {
  return MODEL_OUTPUT_TOKEN_LIMITS[model.trim()];
}

export function parseAnthropicMaxTokens(
  input: string | undefined,
  model: string,
): MaxTokensConfiguration {
  const normalizedModel = model.trim();
  const modelLimit = anthropicModelOutputTokenLimit(normalizedModel);
  if (modelLimit === undefined) {
    return {
      ok: false,
      message:
        `No verified output-token limit is registered for Anthropic model ${normalizedModel}. ` +
        "Verify the model in Anthropic's documentation before updating the local model catalog.",
    };
  }

  const normalizedInput = input?.trim();
  if (normalizedInput === undefined || normalizedInput.length === 0) {
    return { ok: false, message: "ANTHROPIC_MAX_TOKENS is required for live extraction." };
  }
  if (!/^[0-9]+$/u.test(normalizedInput)) {
    return { ok: false, message: "ANTHROPIC_MAX_TOKENS must be a base-10 integer." };
  }

  const value = Number(normalizedInput);
  if (!Number.isSafeInteger(value) || value < MIN_OUTPUT_TOKENS) {
    return {
      ok: false,
      message: `ANTHROPIC_MAX_TOKENS must be an integer from ${MIN_OUTPUT_TOKENS} to ${modelLimit} for ${normalizedModel}.`,
    };
  }
  if (value > modelLimit) {
    return {
      ok: false,
      message: `ANTHROPIC_MAX_TOKENS=${value} exceeds ${normalizedModel}'s ${modelLimit}-token output limit.`,
    };
  }
  return { ok: true, value, modelLimit };
}
