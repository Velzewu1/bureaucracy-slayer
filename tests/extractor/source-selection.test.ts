import { describe, expect, it } from "vitest";

import { SiteSnapshotSchema, hashText } from "../../src/contracts/index.js";
import { selectFocusedSources } from "../../src/extractor/index.js";
import { baseSnapshotFixture } from "../fixtures/p0.js";

const GOAL = "Cancel a transfer or request recovery.";
const GOAL_SCOPE = {
  primaryActionPurpose: "cancel the transfer",
  alternativeActionPurposes: ["request recovery"],
} as const;

function snapshotWithSeparateProhibition() {
  const policyPage = baseSnapshotFixture.pages[0];
  const instantBlock = policyPage.blocks.find((block) => block.id === "block_instant01");
  if (instantBlock === undefined) throw new TypeError("Missing prohibition fixture block");
  return SiteSnapshotSchema.parse({
    ...baseSnapshotFixture,
    pages: [
      {
        ...policyPage,
        blocks: policyPage.blocks.filter((block) => block.id !== instantBlock.id),
      },
      baseSnapshotFixture.pages[1],
      {
        id: "page_restrictions1",
        url: "https://northstar.test/help/transfer-rules",
        canonicalUrl: "https://northstar.test/help/transfer-rules",
        title: "Transfer rules and restrictions",
        capturedAt: baseSnapshotFixture.capturedAt,
        contentHash: "pagerestrictionhash01",
        blocks: [instantBlock],
        actions: [],
      },
    ],
  });
}

describe("goal-focused source selection", () => {
  it("is deterministic and preserves the original snapshot binding", () => {
    const snapshot = SiteSnapshotSchema.parse(baseSnapshotFixture);
    const first = selectFocusedSources(snapshot, GOAL);
    const second = selectFocusedSources(snapshot, GOAL);

    expect(first).toEqual(second);
    expect(first.sourceSnapshotId).toBe(snapshot.id);
    expect(first.sourceSnapshotHash).toBe(snapshot.contentHash);
    expect(first.selectedCounts.pages).toBeLessThanOrEqual(first.originalCounts.pages);
    expect(first.selectionMode).toBe("general");
    expect(first.semanticCoverage).toBe("not_verified");
  });

  it("enables an explicit structural-only goal scope without changing general mode", () => {
    const snapshot = SiteSnapshotSchema.parse(baseSnapshotFixture);
    const selection = selectFocusedSources(snapshot, GOAL, undefined, GOAL_SCOPE);

    expect(selection.selectionMode).toBe("goal_scoped");
    expect(selection.semanticCoverage).toBe("not_verified");
    expect(selection.goalScope).toEqual(GOAL_SCOPE);
    expect(selection.coverage).toBe("complete");
  });

  it("retains a prohibition on a separate policy page and exact block IDs", () => {
    const selection = selectFocusedSources(snapshotWithSeparateProhibition(), GOAL);
    const restrictionPage = selection.pages.find((page) => page.pageId === "page_restrictions1");

    expect(selection.coverage).toBe("complete");
    expect(restrictionPage?.blocks).toContainEqual(
      expect.objectContaining({ blockId: "block_instant01" }),
    );
  });

  it("retains observed controls as evidence candidates without treating visibility as permission", () => {
    const snapshot = SiteSnapshotSchema.parse(baseSnapshotFixture);
    const selection = selectFocusedSources(snapshot, GOAL);
    const transferPage = selection.pages.find((page) => page.pageId === "page_transfer01");

    expect(transferPage?.actions).toContainEqual(
      expect.objectContaining({ websiteActionId: "action_cancel01", visible: true }),
    );
    expect(JSON.stringify(selection)).not.toContain('"effect":"permit"');
  });

  it("reports incomplete coverage when mandatory focused pages exceed the budget", () => {
    const selection = selectFocusedSources(snapshotWithSeparateProhibition(), GOAL, {
      maxPages: 1,
      maxBlocks: 100,
      maxActions: 100,
    });

    expect(selection.coverage).toBe("incomplete");
    expect(selection.limitations).not.toEqual([]);
    expect(selection.selectedCounts.pages).toBe(1);
  });

  it("retains a linked cross-page restriction even when its wording differs from the goal", () => {
    const restrictionText = "Expedited items are unavailable after submission.";
    const policyPage = baseSnapshotFixture.pages[0];
    const restrictionUrl = "https://northstar.test/help/restrictions";
    const snapshot = SiteSnapshotSchema.parse({
      ...baseSnapshotFixture,
      pages: [
        {
          ...policyPage,
          title: "Cancel transfer policies",
          actions: [
            ...policyPage.actions,
            {
              id: "action_restrict01",
              pageId: policyPage.id,
              kind: "link",
              label: "Restrictions and exceptions",
              targetUrl: restrictionUrl,
              method: "GET",
              visible: true,
              enabled: true,
              reversible: true,
              fingerprint: "fingerprintrestrict01",
              locators: [{ strategy: "role", role: "link", name: "Restrictions and exceptions" }],
            },
          ],
        },
        baseSnapshotFixture.pages[1],
        {
          id: "page_restrictions1",
          url: restrictionUrl,
          canonicalUrl: restrictionUrl,
          title: "Restrictions and exceptions",
          capturedAt: baseSnapshotFixture.capturedAt,
          contentHash: "pagerestrictionhash01",
          blocks: [
            {
              id: "block_restrict01",
              text: restrictionText,
              textHash: hashText(restrictionText),
            },
          ],
          actions: [],
        },
      ],
    });

    const selection = selectFocusedSources(snapshot, GOAL, undefined, GOAL_SCOPE);

    expect(selection.pages.find((page) => page.pageId === "page_restrictions1")?.blocks)
      .toContainEqual(expect.objectContaining({ blockId: "block_restrict01" }));
  });

  it("fails coverage explicitly when no primary action or matching policy source is observed", () => {
    const snapshot = SiteSnapshotSchema.parse(baseSnapshotFixture);
    const selection = selectFocusedSources(snapshot, GOAL, undefined, {
      primaryActionPurpose: "reverse a wire",
      alternativeActionPurposes: [],
    });

    expect(selection.coverage).toBe("incomplete");
    expect(selection.limitations).toEqual(expect.arrayContaining([
      "No observed WebsiteAction matched the primary goal-scoped action purpose.",
      "No selected policy evidence matched the primary goal-scoped action purpose.",
    ]));
  });
});
