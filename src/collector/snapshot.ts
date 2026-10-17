import { z } from "zod";

import {
  SiteSnapshotSchema,
  hashCanonical,
  normalizeEvidenceText,
  type EvidenceBlock,
  type PageSnapshot,
  type SiteSnapshot,
  type WebsiteAction,
} from "../contracts/index.js";
import {
  hashEvidenceBlockText,
  hashPageSnapshotContent,
  hashSiteSnapshotContent,
  hashWebsiteActionFingerprint,
} from "../shared/index.js";
import { CollectorError, CollectorErrorCode } from "./errors.js";
import type { ParsedCollectorOptions } from "./options.js";

const LocatorObservationSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("role"), role: z.string().min(1), name: z.string().min(1) }).strict(),
  z.object({ strategy: z.literal("testId"), value: z.string().min(1) }).strict(),
  z.object({ strategy: z.literal("css"), value: z.string().min(1) }).strict(),
]);

const ActionObservationSchema = z
  .object({
    kind: z.enum(["link", "button", "form_control", "form_submit"]),
    label: z.string().min(1),
    targetUrl: z.string().optional(),
    method: z.enum(["GET", "POST"]).optional(),
    visible: z.boolean(),
    enabled: z.boolean(),
    reversible: z.boolean(),
    locators: z.array(LocatorObservationSchema).min(1),
  })
  .strict();

export const DomObservationSchema = z
  .object({
    title: z.string(),
    canonicalHref: z.string().optional(),
    blocks: z.array(z.string()),
    actions: z.array(ActionObservationSchema),
  })
  .strict();

export type DomObservation = z.infer<typeof DomObservationSchema>;

export type ObservedPage = Readonly<{
  requestedUrl: string;
  observedUrl: string;
  depth: number;
  dom: DomObservation;
}>;

function shortHash(value: unknown): string {
  return hashCanonical(value).slice(0, 20);
}

function normalizeUrl(url: URL): string {
  const normalized = new URL(url.href);
  normalized.hash = "";
  normalized.searchParams.sort();
  return normalized.href;
}

export function canonicalizeHttpUrl(value: string, baseUrl?: string): string | undefined {
  let url: URL;
  try {
    url = baseUrl === undefined ? new URL(value) : new URL(value, baseUrl);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
    return undefined;
  }
  return normalizeUrl(url);
}

export function normalizeAllowedOrigins(options: ParsedCollectorOptions): ReadonlySet<string> {
  const start = canonicalizeHttpUrl(options.startUrl);
  if (start === undefined) {
    throw new CollectorError(CollectorErrorCode.invalidStartUrl, "The start URL must be an absolute HTTP(S) URL.");
  }

  const configured = options.allowedOrigins ?? [start];
  const origins = new Set(configured.map((value) => new URL(value).origin));
  if (!origins.has(new URL(start).origin)) {
    throw new CollectorError(
      CollectorErrorCode.originDisallowed,
      "The start URL origin is not present in the allowed-origin set.",
    );
  }
  return origins;
}

export function isAllowedHttpUrl(value: string, allowedOrigins: ReadonlySet<string>): boolean {
  const normalized = canonicalizeHttpUrl(value);
  return normalized !== undefined && allowedOrigins.has(new URL(normalized).origin);
}

function selectCanonicalUrl(page: ObservedPage, allowedOrigins: ReadonlySet<string>): string {
  const observedUrl = canonicalizeHttpUrl(page.observedUrl);
  if (observedUrl === undefined) {
    throw new CollectorError(CollectorErrorCode.pageUnavailable, "The browser reported a non-HTTP(S) page URL.");
  }
  const candidate =
    page.dom.canonicalHref === undefined
      ? undefined
      : canonicalizeHttpUrl(page.dom.canonicalHref, observedUrl);
  return candidate !== undefined && allowedOrigins.has(new URL(candidate).origin) ? candidate : observedUrl;
}

function buildBlocks(
  pageId: string,
  rawBlocks: readonly string[],
  options: ParsedCollectorOptions,
): EvidenceBlock[] {
  const blocks: EvidenceBlock[] = [];
  const occurrences = new Map<string, number>();
  let collectedCharacters = 0;

  for (const rawText of rawBlocks) {
    if (blocks.length >= options.maxBlocksPerPage || collectedCharacters >= options.maxTextCharsPerPage) break;
    const normalized = normalizeEvidenceText(rawText);
    if (normalized.length === 0) continue;

    const remaining = options.maxTextCharsPerPage - collectedCharacters;
    const codePoints = [...normalized];
    const text = codePoints.length > remaining ? codePoints.slice(0, remaining).join("").trim() : normalized;
    if (text.length === 0) break;
    const occurrence = occurrences.get(text) ?? 0;
    occurrences.set(text, occurrence + 1);
    const id = `block_${shortHash({ kind: "EvidenceBlock.id", pageId, text, occurrence })}`;
    blocks.push({ id, text, textHash: hashEvidenceBlockText(text) });
    collectedCharacters += [...text].length;
  }
  return blocks;
}

type LocatorCandidate = WebsiteAction["locators"][number];

function normalizeLocators(locators: readonly LocatorCandidate[]): LocatorCandidate[] {
  const seen = new Set<string>();
  return locators.filter((locator) => {
    const key = JSON.stringify(locator);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildActions(
  pageId: string,
  observedUrl: string,
  rawActions: readonly z.infer<typeof ActionObservationSchema>[],
  options: ParsedCollectorOptions,
): WebsiteAction[] {
  const actions: WebsiteAction[] = [];
  const occurrences = new Map<string, number>();

  for (const rawAction of rawActions) {
    if (actions.length >= options.maxActionsPerPage) break;
    const label = normalizeEvidenceText(rawAction.label);
    if (label.length === 0 || !rawAction.visible) continue;
    const locators = normalizeLocators(rawAction.locators);
    if (locators.length === 0) continue;

    const targetUrl =
      rawAction.targetUrl === undefined
        ? undefined
        : canonicalizeHttpUrl(rawAction.targetUrl, observedUrl);
    const identity = {
      kind: rawAction.kind,
      label,
      targetUrl: targetUrl ?? null,
      method: rawAction.method ?? null,
      locators,
    };
    const identityKey = hashCanonical(identity);
    const occurrence = occurrences.get(identityKey) ?? 0;
    occurrences.set(identityKey, occurrence + 1);
    const id = `action_${shortHash({ kind: "WebsiteAction.id", pageId, identity, occurrence })}`;

    const fingerprintInput = {
      pageId,
      kind: rawAction.kind,
      label,
      reversible: rawAction.reversible,
      locators,
      ...(targetUrl === undefined ? {} : { targetUrl }),
      ...(rawAction.method === undefined ? {} : { method: rawAction.method }),
    };
    actions.push({
      id,
      ...fingerprintInput,
      visible: true,
      enabled: rawAction.enabled,
      fingerprint: hashWebsiteActionFingerprint(fingerprintInput),
    });
  }
  return actions;
}

function buildPage(
  observed: ObservedPage,
  capturedAt: string,
  allowedOrigins: ReadonlySet<string>,
  options: ParsedCollectorOptions,
): PageSnapshot {
  const url = canonicalizeHttpUrl(observed.observedUrl);
  if (url === undefined) {
    throw new CollectorError(CollectorErrorCode.pageUnavailable, "The browser reported a non-HTTP(S) page URL.");
  }
  const canonicalUrl = selectCanonicalUrl(observed, allowedOrigins);
  const id = `page_${shortHash({ kind: "PageSnapshot.id", canonicalUrl })}`;
  const blocks = buildBlocks(id, observed.dom.blocks, options);
  const actions = buildActions(id, url, observed.dom.actions, options);
  const content = {
    id,
    url,
    canonicalUrl,
    title: normalizeEvidenceText(observed.dom.title),
    capturedAt,
    blocks,
    actions,
  };
  return { ...content, contentHash: hashPageSnapshotContent(content) };
}

export function buildSiteSnapshot(
  observedPages: readonly ObservedPage[],
  options: ParsedCollectorOptions,
  capturedAt: string,
): SiteSnapshot {
  const allowedOrigins = normalizeAllowedOrigins(options);
  const rootUrl = canonicalizeHttpUrl(options.startUrl);
  if (rootUrl === undefined) {
    throw new CollectorError(CollectorErrorCode.invalidStartUrl, "The start URL must be an absolute HTTP(S) URL.");
  }
  const siteId = `site_${shortHash({ kind: "SiteSnapshot.siteId", origin: new URL(rootUrl).origin })}`;
  const pages = observedPages.map((page) => buildPage(page, capturedAt, allowedOrigins, options));
  const id = `snapshot_${shortHash({
    kind: "SiteSnapshot.id",
    siteId,
    rootUrl,
    pages: pages.map((page) => ({ id: page.id, contentHash: page.contentHash })),
  })}`;
  const content = { schemaVersion: 1 as const, id, siteId, rootUrl, capturedAt, pages };
  const candidate = { ...content, contentHash: hashSiteSnapshotContent(content) };
  const result = SiteSnapshotSchema.safeParse(candidate);
  if (!result.success) {
    throw new CollectorError(
      CollectorErrorCode.snapshotSchemaInvalid,
      "Collected website data did not satisfy the SiteSnapshot contract.",
      { issueCount: String(result.error.issues.length) },
      result.error,
    );
  }
  return result.data;
}

export function discoverCrawlTargets(
  page: ObservedPage,
  allowedOrigins: ReadonlySet<string>,
): readonly string[] {
  const targets = new Set<string>();
  for (const action of page.dom.actions) {
    if (
      action.kind !== "link" ||
      action.targetUrl === undefined ||
      !action.visible ||
      !action.enabled ||
      !action.reversible
    ) {
      continue;
    }
    const target = canonicalizeHttpUrl(action.targetUrl, page.observedUrl);
    if (target !== undefined && allowedOrigins.has(new URL(target).origin)) targets.add(target);
  }
  return [...targets];
}
