import { z } from "zod";

import { CollectorError, CollectorErrorCode } from "./errors.js";

const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  }, "Expected an HTTP(S) URL without embedded credentials");

const StartUrlBoundarySchema = z.object({ startUrl: HttpUrlSchema }).passthrough();

export const CollectorOptionsSchema = z
  .object({
    startUrl: HttpUrlSchema,
    allowedOrigins: z.array(HttpUrlSchema).min(1).optional(),
    maxPages: z.number().int().min(1).max(12).default(8),
    maxDepth: z.number().int().min(0).max(8).default(2),
    navigationTimeoutMs: z.number().int().min(100).max(120_000).default(10_000),
    navigationRetries: z.union([z.literal(0), z.literal(1)]).default(0),
    maxTextCharsPerPage: z.number().int().min(1).max(250_000).default(30_000),
    maxBlocksPerPage: z.number().int().min(1).max(1_000).default(200),
    maxActionsPerPage: z.number().int().min(1).max(1_000).default(100),
    headless: z.boolean().default(true),
  })
  .strict();

export type CollectorOptions = z.input<typeof CollectorOptionsSchema>;
export type ParsedCollectorOptions = z.output<typeof CollectorOptionsSchema>;

export function parseCollectorOptions(input: unknown): ParsedCollectorOptions {
  const startUrlResult = StartUrlBoundarySchema.safeParse(input);
  if (!startUrlResult.success) {
    throw new CollectorError(
      CollectorErrorCode.invalidStartUrl,
      "The start URL must be an absolute HTTP(S) URL without embedded credentials.",
      { issueCount: String(startUrlResult.error.issues.length) },
      startUrlResult.error,
    );
  }
  const result = CollectorOptionsSchema.safeParse(input);
  if (!result.success) {
    throw new CollectorError(
      CollectorErrorCode.invalidOptions,
      "Collector options did not pass validation.",
      { issueCount: String(result.error.issues.length) },
      result.error,
    );
  }
  return result.data;
}
