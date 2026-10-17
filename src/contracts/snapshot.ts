import { z } from "zod";

import { HashSchema, HttpUrlSchema, IdSchema, IsoDateTimeSchema } from "./primitives.js";

export const EvidenceBlockSchema = z
  .object({
    id: IdSchema,
    text: z.string().min(1),
    textHash: HashSchema,
  })
  .strict();

export const LocatorCandidateSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("role"), role: z.string().min(1), name: z.string().min(1) }).strict(),
  z.object({ strategy: z.literal("testId"), value: z.string().min(1) }).strict(),
  z.object({ strategy: z.literal("css"), value: z.string().min(1) }).strict(),
]);

export const WebsiteActionSchema = z
  .object({
    id: IdSchema,
    pageId: IdSchema,
    kind: z.enum(["link", "button", "form_control", "form_submit"]),
    label: z.string().min(1),
    targetUrl: HttpUrlSchema.optional(),
    method: z.enum(["GET", "POST"]).optional(),
    visible: z.boolean(),
    enabled: z.boolean(),
    reversible: z.boolean().default(false),
    fingerprint: HashSchema,
    locators: z.array(LocatorCandidateSchema).min(1),
  })
  .strict();

export const PageSnapshotSchema = z
  .object({
    id: IdSchema,
    url: HttpUrlSchema,
    canonicalUrl: HttpUrlSchema,
    title: z.string(),
    capturedAt: IsoDateTimeSchema,
    contentHash: HashSchema,
    blocks: z.array(EvidenceBlockSchema),
    actions: z.array(WebsiteActionSchema),
  })
  .strict()
  .superRefine((page, context) => {
    const identifiers = new Set<string>();
    for (const block of page.blocks) {
      if (identifiers.has(block.id)) {
        context.addIssue({ code: "custom", message: `Duplicate page member id: ${block.id}` });
      }
      identifiers.add(block.id);
    }
    for (const action of page.actions) {
      if (identifiers.has(action.id)) {
        context.addIssue({ code: "custom", message: `Duplicate page member id: ${action.id}` });
      }
      identifiers.add(action.id);
      if (action.pageId !== page.id) {
        context.addIssue({ code: "custom", message: `Action ${action.id} does not belong to page ${page.id}` });
      }
    }
  });

export const SiteSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: IdSchema,
    siteId: IdSchema,
    rootUrl: HttpUrlSchema,
    capturedAt: IsoDateTimeSchema,
    contentHash: HashSchema,
    pages: z.array(PageSnapshotSchema).min(1).max(12),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const identifiers = new Set<string>();
    for (const page of snapshot.pages) {
      if (identifiers.has(page.id)) {
        context.addIssue({ code: "custom", message: `Duplicate snapshot id: ${page.id}` });
      }
      identifiers.add(page.id);
      for (const block of page.blocks) {
        if (identifiers.has(block.id)) {
          context.addIssue({ code: "custom", message: `Duplicate snapshot id: ${block.id}` });
        }
        identifiers.add(block.id);
      }
      for (const action of page.actions) {
        if (identifiers.has(action.id)) {
          context.addIssue({ code: "custom", message: `Duplicate snapshot id: ${action.id}` });
        }
        identifiers.add(action.id);
      }
    }
  });

export type EvidenceBlock = z.infer<typeof EvidenceBlockSchema>;
export type WebsiteAction = z.infer<typeof WebsiteActionSchema>;
export type PageSnapshot = z.infer<typeof PageSnapshotSchema>;
export type SiteSnapshot = z.infer<typeof SiteSnapshotSchema>;

