import { z } from "zod";

/**
 * GuidanceEnvelope: the ONLY plan data the extension accepts.
 *
 * It is a sanitized, read-only projection of a SafeActionPlan produced by the
 * existing deterministic pipeline (evidence validation -> evaluator -> planner).
 * The extension never evaluates policy; it only checks the envelope's shape,
 * integrity, origin, freshness and navigation grounding before showing it.
 *
 * Deliberately absent: user fact values, fact keys, rule IDs, raw model output,
 * credentials, and plan/hash internals shown to users.
 */

export const ENVELOPE_SCHEMA_VERSION = 1;

const OriginSchema = z
  .string()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
    } catch {
      return false;
    }
  }, "Expected a bare http(s) origin");

const HttpUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}, "Expected an http(s) URL without credentials");

export const PlanStatusSchema = z.enum(["ready", "needs_information", "blocked", "review_required", "stale"]);
export type PlanStatus = z.infer<typeof PlanStatusSchema>;

export const GuidanceTargetSchema = z
  .object({
    /** Observed WebsiteAction identity (provenance only; never proof of safety). */
    websiteActionId: z.string().min(1),
    actionKind: z.enum(["link", "button", "form_control", "form_submit"]),
    method: z.enum(["GET", "POST"]).optional(),
    label: z.string().min(1),
    /** Observed page that contains the control. */
    sourcePageUrl: HttpUrlSchema,
    /** Where an observed link leads, when the observation recorded one. */
    destinationUrl: HttpUrlSchema.optional(),
    /** Accessible role/name from the observed role locator, used to find the control. */
    role: z.string().min(1).optional(),
    accessibleName: z.string().min(1),
  })
  .strict();

export const GuidanceStepSchema = z
  .object({
    index: z.number().int().positive(),
    title: z.string().min(1),
    instruction: z.string().min(1),
    citationIds: z.array(z.string().min(1)).min(1),
    target: GuidanceTargetSchema.nullable(),
  })
  .strict();

export const GuidanceCitationSchema = z
  .object({
    id: z.string().min(1),
    pageTitle: z.string(),
    pageUrl: HttpUrlSchema,
    excerpt: z.string().min(1),
  })
  .strict();

export const GuidanceEnvelopeBodySchema = z
  .object({
    schemaVersion: z.literal(ENVELOPE_SCHEMA_VERSION),
    /** Only "fixture_demo" exists. A live bridge would need a new, explicitly reviewed kind. */
    source: z.literal("fixture_demo"),
    sourceLabel: z.string().min(1),
    sessionId: z.string().min(1),
    /** Monotonic per session; an older sequence can never replace a newer accepted one. */
    sequence: z.number().int().positive(),
    /** Freshness window measured from the moment the extension accepts the envelope. */
    validForMs: z.number().int().positive().max(60 * 60 * 1000),
    trustedOrigin: OriginSchema,
    goal: z.string().min(1),
    planStatus: PlanStatusSchema,
    notices: z.array(z.string().min(1)),
    missingFactLabels: z.array(z.string().min(1)),
    steps: z.array(GuidanceStepSchema),
    citations: z.array(GuidanceCitationSchema),
    /** Observed page URLs. Every navigation/highlight target must be one of these. */
    observedPages: z.array(HttpUrlSchema).min(1),
    /** Opaque bindings to the verified artifacts; never displayed. */
    binding: z
      .object({
        planId: z.string().min(1),
        snapshotId: z.string().min(1),
        snapshotHash: z.string().min(1),
        userStateRevision: z.number().int().nonnegative(),
        userStateHash: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const GuidanceEnvelopeSchema = GuidanceEnvelopeBodySchema.extend({
  /** sha256 hex over the canonical JSON of every other field. Detects tampering/corruption only. */
  integrity: z.string().regex(/^[0-9a-f]{64}$/),
}).superRefine((envelope, context) => {
  // Fail closed: only a ready plan may carry steps, and a ready plan must carry some.
  if (envelope.planStatus === "ready" && envelope.steps.length === 0) {
    context.addIssue({ code: "custom", message: "A ready plan must contain steps." });
  }
  if (envelope.planStatus !== "ready" && envelope.steps.length > 0) {
    context.addIssue({ code: "custom", message: "Only a ready plan may contain steps." });
  }
  const citationIds = new Set(envelope.citations.map((citation) => citation.id));
  if (citationIds.size !== envelope.citations.length) {
    context.addIssue({ code: "custom", message: "Duplicate citation id." });
  }
  const indexes = envelope.steps.map((step) => step.index);
  if (indexes.some((value, position) => value !== position + 1)) {
    context.addIssue({ code: "custom", message: "Step indexes must be consecutive from 1." });
  }
  for (const step of envelope.steps) {
    for (const id of step.citationIds) {
      if (!citationIds.has(id)) {
        context.addIssue({ code: "custom", message: `Step ${step.index} cites an unknown citation.` });
      }
    }
  }
});

export type GuidanceTarget = z.infer<typeof GuidanceTargetSchema>;
export type GuidanceStep = z.infer<typeof GuidanceStepSchema>;
export type GuidanceCitation = z.infer<typeof GuidanceCitationSchema>;
export type GuidanceEnvelopeBody = z.infer<typeof GuidanceEnvelopeBodySchema>;
export type GuidanceEnvelope = z.infer<typeof GuidanceEnvelopeSchema>;

/** Deterministic JSON with sorted object keys; undefined members are omitted. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sealEnvelope(body: GuidanceEnvelopeBody): Promise<GuidanceEnvelope> {
  const parsedBody = GuidanceEnvelopeBodySchema.parse(body);
  const integrity = await sha256Hex(canonicalJson(parsedBody));
  return GuidanceEnvelopeSchema.parse({ ...parsedBody, integrity });
}
