import { createHash } from "node:crypto";

import {
  normalizeEvidenceText,
  type EvidenceBlock,
  type PageSnapshot,
  type SiteSnapshot,
  type UserState,
  type WebsiteAction,
} from "../contracts/index.js";

export type WebsiteActionFingerprintInput = Pick<
  WebsiteAction,
  "pageId" | "kind" | "label" | "targetUrl" | "method" | "reversible" | "locators"
>;

export type PageSnapshotHashInput = Pick<
  PageSnapshot,
  "id" | "url" | "canonicalUrl" | "title" | "blocks" | "actions"
>;

export type SiteSnapshotHashInput = Pick<SiteSnapshot, "schemaVersion" | "id" | "siteId" | "rootUrl"> &
  Readonly<{ pages: readonly PageSnapshotHashInput[] }>;

function canonicalSerialize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot hash a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`Cannot hash a value of type ${typeof value}`);
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashCanonicalValue(value: unknown): string {
  return sha256Utf8(canonicalSerialize(value));
}

function evidenceBlockPreimage(block: EvidenceBlock): unknown {
  return { id: block.id, text: block.text, textHash: block.textHash };
}

function websiteActionPreimage(action: WebsiteAction): unknown {
  return {
    id: action.id,
    pageId: action.pageId,
    kind: action.kind,
    label: action.label,
    targetUrl: action.targetUrl ?? null,
    method: action.method ?? null,
    visible: action.visible,
    enabled: action.enabled,
    reversible: action.reversible,
    fingerprint: action.fingerprint,
    locators: action.locators,
  };
}

/** Existing evidence-block recipe: normalized text bytes only. */
export function hashEvidenceBlockText(text: string): string {
  return sha256Utf8(normalizeEvidenceText(text));
}

/** Stable semantic binding for re-observing one website action. */
export function hashWebsiteActionFingerprint(action: WebsiteActionFingerprintInput): string {
  return hashCanonicalValue({
    hashVersion: 1,
    kind: "WebsiteAction.fingerprint",
    pageId: action.pageId,
    actionKind: action.kind,
    label: action.label,
    targetUrl: action.targetUrl ?? null,
    method: action.method ?? null,
    reversible: action.reversible,
    locators: action.locators,
  });
}

/** Page content only; capture time and the page's own contentHash are intentionally excluded. */
export function hashPageSnapshotContent(page: PageSnapshotHashInput): string {
  return hashCanonicalValue({
    hashVersion: 1,
    kind: "PageSnapshot.contentHash",
    id: page.id,
    url: page.url,
    canonicalUrl: page.canonicalUrl,
    title: page.title,
    blocks: page.blocks.map(evidenceBlockPreimage),
    actions: page.actions.map(websiteActionPreimage),
  });
}

/** Site content only; capture time and supplied page/site hashes are recomputed or excluded. */
export function hashSiteSnapshotContent(snapshot: SiteSnapshotHashInput): string {
  return hashCanonicalValue({
    hashVersion: 1,
    kind: "SiteSnapshot.contentHash",
    schemaVersion: snapshot.schemaVersion,
    id: snapshot.id,
    siteId: snapshot.siteId,
    rootUrl: snapshot.rootUrl,
    pages: snapshot.pages.map((page) => ({ id: page.id, contentHash: hashPageSnapshotContent(page) })),
  });
}

/** Existing user-state recipe, retained byte-for-byte for fixture and CLI compatibility. */
export function hashUserState(userState: UserState): string {
  return hashCanonicalValue(userState);
}

