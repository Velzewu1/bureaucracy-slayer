import { describe, expect, it } from "vitest";

import { SiteSnapshotSchema, normalizeEvidenceText } from "../../src/contracts/index.js";
import {
  hashEvidenceBlockText,
  hashPageSnapshotContent,
  hashSiteSnapshotContent,
  hashWebsiteActionFingerprint,
} from "../../src/shared/index.js";
import { CollectorError } from "../../src/collector/errors.js";
import { parseCollectorOptions } from "../../src/collector/options.js";
import {
  DomObservationSchema,
  buildSiteSnapshot,
  canonicalizeHttpUrl,
  discoverCrawlTargets,
  isAllowedHttpUrl,
  normalizeAllowedOrigins,
  type ObservedPage,
} from "../../src/collector/snapshot.js";

const CAPTURED_AT = "2026-10-16T18:00:00.000Z";

function options(overrides: Readonly<Record<string, unknown>> = {}) {
  return parseCollectorOptions({ startUrl: "http://127.0.0.1:5180/start", ...overrides });
}

function observedPage(overrides: Partial<ObservedPage> = {}): ObservedPage {
  return {
    requestedUrl: "http://127.0.0.1:5180/start",
    observedUrl: "http://127.0.0.1:5180/start",
    depth: 0,
    dom: {
      title: "  Policy   center ",
      blocks: [" Scheduled\n transfers may be canceled. "],
      actions: [
        {
          kind: "link",
          label: " Read policy ",
          targetUrl: "http://127.0.0.1:5180/policy#details",
          method: "GET",
          visible: true,
          enabled: true,
          reversible: true,
          locators: [{ strategy: "role", role: "link", name: "Read policy" }],
        },
        {
          kind: "button",
          label: "Cancel transfer",
          visible: true,
          enabled: false,
          reversible: false,
          locators: [{ strategy: "testId", value: "cancel-transfer" }],
        },
      ],
    },
    ...overrides,
  };
}

describe("collector snapshot assembly", () => {
  it("produces a strict schema-valid snapshot with canonical hashes", () => {
    const snapshot = buildSiteSnapshot([observedPage()], options(), CAPTURED_AT);
    const parsed = SiteSnapshotSchema.parse(snapshot);
    const page = parsed.pages[0];
    if (page === undefined) throw new Error("Expected one captured page");
    const block = page.blocks[0];
    const link = page.actions[0];
    if (block === undefined || link === undefined) throw new Error("Expected captured content");

    expect(page.title).toBe("Policy center");
    expect(block.text).toBe(normalizeEvidenceText(" Scheduled\n transfers may be canceled. "));
    expect(block.textHash).toBe(hashEvidenceBlockText(block.text));
    expect(link.targetUrl).toBe("http://127.0.0.1:5180/policy");
    expect(link.fingerprint).toBe(hashWebsiteActionFingerprint(link));
    expect(page.contentHash).toBe(hashPageSnapshotContent(page));
    expect(parsed.contentHash).toBe(hashSiteSnapshotContent(parsed));
  });

  it("keeps identities and hashes stable across unchanged captures", () => {
    const first = buildSiteSnapshot([observedPage()], options(), CAPTURED_AT);
    const second = buildSiteSnapshot([observedPage()], options(), "2030-01-01T00:00:00.000Z");

    expect(second.id).toBe(first.id);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.pages.map((page) => page.id)).toEqual(first.pages.map((page) => page.id));
    expect(second.pages.flatMap((page) => page.blocks.map((block) => block.id))).toEqual(
      first.pages.flatMap((page) => page.blocks.map((block) => block.id)),
    );
    expect(second.pages.flatMap((page) => page.actions.map((action) => action.id))).toEqual(
      first.pages.flatMap((page) => page.actions.map((action) => action.id)),
    );
  });

  it("changes content bindings when policy text or action semantics change", () => {
    const original = buildSiteSnapshot([observedPage()], options(), CAPTURED_AT);
    const changedText = buildSiteSnapshot(
      [observedPage({ dom: { ...observedPage().dom, blocks: ["A changed policy."] } })],
      options(),
      CAPTURED_AT,
    );
    const firstAction = observedPage().dom.actions[0];
    if (firstAction === undefined) throw new Error("Expected an action");
    const changedAction = buildSiteSnapshot(
      [
        observedPage({
          dom: {
            ...observedPage().dom,
            actions: [{ ...firstAction, label: "Read revised policy" }],
          },
        }),
      ],
      options(),
      CAPTURED_AT,
    );

    expect(changedText.id).not.toBe(original.id);
    expect(changedText.contentHash).not.toBe(original.contentHash);
    expect(changedAction.pages[0]?.actions[0]?.fingerprint).not.toBe(
      original.pages[0]?.actions[0]?.fingerprint,
    );
  });

  it("distinguishes duplicate block and action occurrences without fabricating content", () => {
    const page = observedPage();
    const firstAction = page.dom.actions[0];
    if (firstAction === undefined) throw new Error("Expected an action");
    const snapshot = buildSiteSnapshot(
      [
        observedPage({
          dom: {
            ...page.dom,
            blocks: ["Same policy", "Same   policy"],
            actions: [firstAction, firstAction],
          },
        }),
      ],
      options(),
      CAPTURED_AT,
    );
    const captured = snapshot.pages[0];
    if (captured === undefined) throw new Error("Expected one captured page");

    expect(new Set(captured.blocks.map((block) => block.id)).size).toBe(2);
    expect(new Set(captured.actions.map((action) => action.id)).size).toBe(2);
    expect(captured.blocks.map((block) => block.text)).toEqual(["Same policy", "Same policy"]);
  });

  it("enforces text, block, and action limits before hashing", () => {
    const page = observedPage();
    const snapshot = buildSiteSnapshot(
      [
        observedPage({
          dom: {
            ...page.dom,
            blocks: ["123456", "not collected"],
            actions: page.dom.actions,
          },
        }),
      ],
      options({ maxTextCharsPerPage: 4, maxBlocksPerPage: 1, maxActionsPerPage: 1 }),
      CAPTURED_AT,
    );
    const captured = snapshot.pages[0];
    if (captured === undefined) throw new Error("Expected one captured page");

    expect(captured.blocks.map((block) => block.text)).toEqual(["1234"]);
    expect(captured.actions).toHaveLength(1);
  });
});

describe("collector boundaries", () => {
  it("normalizes URL fragments and query ordering while rejecting unsafe schemes and credentials", () => {
    expect(canonicalizeHttpUrl("/policy?b=2&a=1#quote", "http://example.test/start")).toBe(
      "http://example.test/policy?a=1&b=2",
    );
    expect(canonicalizeHttpUrl("javascript:alert(1)", "http://example.test/")).toBeUndefined();
    expect(canonicalizeHttpUrl("http://user:password@example.test/")).toBeUndefined();
  });

  it("defaults to the starting origin and rejects a start origin outside an explicit allowlist", () => {
    const defaults = options();
    const allowed = normalizeAllowedOrigins(defaults);
    expect(isAllowedHttpUrl("http://127.0.0.1:5180/policy", allowed)).toBe(true);
    expect(isAllowedHttpUrl("https://external.example/policy", allowed)).toBe(false);

    expect(() =>
      normalizeAllowedOrigins(options({ allowedOrigins: ["http://localhost:5180"] })),
    ).toThrowError(CollectorError);
  });

  it("discovers only HTTP links on allowed origins", () => {
    const allowed = normalizeAllowedOrigins(options());
    const page = observedPage({
      dom: {
        ...observedPage().dom,
        actions: [
          ...observedPage().dom.actions,
          {
            kind: "link",
            label: "External",
            targetUrl: "https://external.example/leave",
            method: "GET",
            visible: true,
            enabled: true,
            reversible: true,
            locators: [{ strategy: "role", role: "link", name: "External" }],
          },
        ],
      },
    });

    expect(discoverCrawlTargets(page, allowed)).toEqual(["http://127.0.0.1:5180/policy"]);
  });

  it("rejects malformed browser observations and invalid collection bounds", () => {
    expect(DomObservationSchema.safeParse({ title: "x", blocks: [], actions: [], extra: true }).success).toBe(false);
    expect(() => parseCollectorOptions({ startUrl: "file:///tmp/site.html" })).toThrowError(
      expect.objectContaining({ code: "INVALID_START_URL" }),
    );
    expect(() => parseCollectorOptions({ startUrl: "http://example.test/", maxPages: 13 })).toThrowError(
      expect.objectContaining({ code: "INVALID_OPTIONS" }),
    );
  });
});
