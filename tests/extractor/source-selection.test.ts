import { describe, expect, it } from "vitest";

import { SiteSnapshotSchema, hashText } from "../../src/contracts/index.js";
import {
  deriveObservedGoalScope,
  selectFocusedSources,
} from "../../src/extractor/index.js";
import { recordedSonnetBundleInput } from "../../src/ui/generated/recordedSonnetBundle.js";
import { RecordedExtractionBundleSchema } from "../../src/ui/recordedBundle.js";
import { baseSnapshotFixture } from "../fixtures/p0.js";

const GOAL = "Cancel a transfer or request recovery.";
const GOAL_SCOPE = {
  primaryActionPurpose: "cancel the transfer",
  alternativeActionPurposes: ["request recovery"],
} as const;

const RECORDED_CRITICAL_BLOCK_IDS = [
  "block_fc059175893c4915951c",
  "block_76a78eb111477e8c92e8",
  "block_0408d3189733d101eb07",
  "block_4b3e165045ebe5b2a429",
] as const;

type SyntheticPage = Readonly<{
  id: string;
  path: string;
  title: string;
  blocks: readonly Readonly<{ id: string; text: string }>[];
  actions?: readonly Readonly<{
    id: string;
    kind: "link" | "button" | "form_control" | "form_submit";
    label: string;
    targetPath?: string;
  }>[];
}>;

function syntheticSnapshot(name: string, pages: readonly SyntheticPage[]) {
  const origin = `https://${name}.test`;
  return SiteSnapshotSchema.parse({
    schemaVersion: 1,
    id: `snapshot_${name}01`,
    siteId: `site_${name}01`,
    rootUrl: `${origin}${pages[0]?.path ?? "/"}`,
    capturedAt: "2026-10-17T12:00:00.000Z",
    contentHash: `snapshotcontent${name}01`,
    pages: pages.map((page) => ({
      id: page.id,
      url: `${origin}${page.path}`,
      canonicalUrl: `${origin}${page.path}`,
      title: page.title,
      capturedAt: "2026-10-17T12:00:00.000Z",
      contentHash: `pagecontent${page.id}`,
      blocks: page.blocks.map((block) => ({
        ...block,
        textHash: hashText(block.text),
      })),
      actions: (page.actions ?? []).map((action) => ({
        id: action.id,
        pageId: page.id,
        kind: action.kind,
        label: action.label,
        ...(action.targetPath === undefined ? {} : { targetUrl: `${origin}${action.targetPath}` }),
        ...(action.kind === "link" ? { method: "GET" as const } : {}),
        visible: true,
        enabled: true,
        reversible: action.kind === "link",
        fingerprint: `fingerprint${action.id}`,
        locators: [{ strategy: "role" as const, role: action.kind, name: action.label }],
      })),
    })),
  });
}

function selectedBlockIds(selection: ReturnType<typeof selectFocusedSources>): Set<string> {
  return new Set(selection.pages.flatMap((page) => page.blocks.map((block) => block.blockId)));
}

function selectedActionIds(selection: ReturnType<typeof selectFocusedSources>): Set<string> {
  return new Set(
    selection.pages.flatMap((page) => page.actions.map((action) => action.websiteActionId)),
  );
}

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
  it("derives distinct bounded scopes for cancellation, recovery, and recovery prerequisites", () => {
    const snapshot = RecordedExtractionBundleSchema.parse(
      recordedSonnetBundleInput,
    ).sourceSnapshot;
    const cases = [
      {
        goal: "Can I cancel a scheduled Standard transfer before processing starts?",
        purpose: "Cancel transfer",
        requiredBlockId: "block_c6e0f05342f8d9849468",
        expectedCounts: { pages: 9, blocks: 70, actions: 20 },
      },
      {
        goal: "Can I request recovery for a completed transfer?",
        purpose: "Request recovery of a completed transfer",
        requiredBlockId: "block_dd35d4ab423bc204bf21",
        expectedCounts: { pages: 7, blocks: 66, actions: 15 },
      },
      {
        goal: "What information do I need to submit a recovery request?",
        purpose: "Submit recovery request",
        requiredBlockId: "block_b9b4f21bf280d76622d6",
        expectedCounts: { pages: 8, blocks: 62, actions: 20 },
      },
    ] as const;

    const selections = cases.map(({ goal, purpose, requiredBlockId, expectedCounts }) => {
      const scope = deriveObservedGoalScope(snapshot, goal);
      expect(scope?.primaryActionPurpose).toBe(purpose);
      const selection = selectFocusedSources(
        snapshot,
        goal,
        { maxPages: 9, maxBlocks: 80, maxActions: 35 },
        scope,
      );
      expect(selection.coverage).toBe("complete");
      expect(selection.selectedCounts.pages).toBeLessThanOrEqual(9);
      expect(selection.selectedCounts.blocks).toBeLessThanOrEqual(80);
      expect(selection.selectedCounts.actions).toBeLessThanOrEqual(35);
      expect(selection.selectedCounts).toEqual(expectedCounts);
      expect(selectedBlockIds(selection)).toContain(requiredBlockId);
      return selection;
    });

    expect(selections.map((selection) => selection.goalScope?.primaryActionPurpose))
      .toEqual(cases.map(({ purpose }) => purpose));
    expect(new Set(selections.map((selection) => JSON.stringify(selection.pages))).size).toBe(3);
    expect(deriveObservedGoalScope(snapshot, "How do I close my mortgage?")).toBeUndefined();
  });

  it("recovers the recorded operative permissions, exceptions, eligibility, and cancel control", () => {
    const bundle = RecordedExtractionBundleSchema.parse(recordedSonnetBundleInput);
    const budget = { maxPages: 9, maxBlocks: 80, maxActions: 35 } as const;
    const first = selectFocusedSources(
      bundle.sourceSnapshot,
      bundle.extractionGoal,
      budget,
      bundle.goalScope,
    );
    const second = selectFocusedSources(
      bundle.sourceSnapshot,
      bundle.extractionGoal,
      budget,
      bundle.goalScope,
    );
    const blockIds = selectedBlockIds(first);
    const actionIds = selectedActionIds(first);

    expect(first).toEqual(second);
    expect(first.originalCounts).toEqual({ pages: 9, blocks: 126, actions: 107 });
    expect(first.semanticCoverage).toBe("not_verified");
    expect(first.coverage).toBe("complete");
    expect(first.selectedCounts.pages).toBeLessThanOrEqual(budget.maxPages);
    expect(first.selectedCounts.blocks).toBeLessThanOrEqual(budget.maxBlocks);
    expect(first.selectedCounts.actions).toBeLessThanOrEqual(budget.maxActions);
    expect(RECORDED_CRITICAL_BLOCK_IDS.every((blockId) => blockIds.has(blockId))).toBe(true);
    expect(actionIds).toContain("action_cec971f543cc085511e5");
  });

  it("reports the recorded goal as incomplete when its required sources exceed a smaller budget", () => {
    const bundle = RecordedExtractionBundleSchema.parse(recordedSonnetBundleInput);
    const selection = selectFocusedSources(
      bundle.sourceSnapshot,
      bundle.extractionGoal,
      { maxPages: 8, maxBlocks: 76, maxActions: 30 },
      bundle.goalScope,
    );

    expect(selection.coverage).toBe("incomplete");
    expect(selection.limitations).not.toEqual([]);
  });

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

  it("does not let frequent primary-intent vocabulary disappear behind a fallback intent", () => {
    const snapshot = syntheticSnapshot("badge", [
      {
        id: "page_badgepolicy1",
        path: "/badge/replacement",
        title: "Badge replacement policy",
        blocks: [
          { id: "block_badgeintro1", text: "Replace a badge" },
          {
            id: "block_badgepermit1",
            text: "Employees may replace an active badge after identity verification.",
          },
        ],
        actions: [
          { id: "action_badgereplace1", kind: "button", label: "Replace badge" },
        ],
      },
      {
        id: "page_badgefallback1",
        path: "/badge/temporary-pass",
        title: "Temporary access pass",
        blocks: [
          {
            id: "block_passpermit1",
            text: "Employees may request a temporary pass while a badge replacement is reviewed.",
          },
          { id: "block_badgefooter1", text: "Replace badge information is also available." },
        ],
        actions: [
          { id: "action_passrequest1", kind: "button", label: "Request temporary pass" },
        ],
      },
      {
        id: "page_badgesecurity1",
        path: "/security",
        title: "Security desk",
        blocks: [
          { id: "block_badgesecurity1", text: "Ask security where to replace a badge." },
        ],
      },
      {
        id: "page_badgedirectory1",
        path: "/directory",
        title: "Office directory",
        blocks: [
          { id: "block_badgedirectory1", text: "Directory for teams that replace badge equipment." },
        ],
      },
    ]);

    const selection = selectFocusedSources(
      snapshot,
      "My badge broke. Can I replace it, or request a temporary pass?",
      undefined,
      {
        primaryActionPurpose: "replace badge",
        alternativeActionPurposes: ["request temporary pass"],
      },
    );

    expect(selection.coverage).toBe("complete");
    expect(selectedBlockIds(selection)).toContain("block_badgepermit1");
    expect(selectedActionIds(selection)).toContain("action_badgereplace1");
  });

  it("keeps a linked exception and an independently selected fallback without sweeping unrelated pages", () => {
    const snapshot = syntheticSnapshot("enrollment", [
      {
        id: "page_withdrawal1",
        path: "/withdrawal",
        title: "Enrollment withdrawal",
        blocks: [
          { id: "block_withdrawheading1", text: "Withdrawal rules" },
          {
            id: "block_withdrawpermit1",
            text: "Enrolled students may withdraw before the census date.",
          },
          {
            id: "block_withdrawscope1",
            text: "After that date, review the dean exceptions before starting a withdrawal.",
          },
        ],
        actions: [
          { id: "action_withdraw1", kind: "button", label: "Withdraw enrollment" },
          {
            id: "action_deanexceptions1",
            kind: "link",
            label: "Dean exceptions",
            targetPath: "/withdrawal/exceptions",
          },
        ],
      },
      {
        id: "page_deanexception1",
        path: "/withdrawal/exceptions",
        title: "Dean exceptions",
        blocks: [
          { id: "block_exceptionheading1", text: "Medical leave" },
          {
            id: "block_exceptionrule1",
            text: "A documented medical leave requires dean approval after the census date.",
          },
        ],
      },
      {
        id: "page_tuitionappeal1",
        path: "/tuition/appeal",
        title: "Tuition appeal",
        blocks: [
          {
            id: "block_appealpermit1",
            text: "A student may file a tuition appeal after a withdrawal request is denied.",
          },
        ],
        actions: [
          { id: "action_appeal1", kind: "button", label: "File tuition appeal" },
        ],
      },
      {
        id: "page_catering1",
        path: "/campus/catering",
        title: "Campus catering",
        blocks: [
          { id: "block_catering1", text: "Request lunch service for a department meeting." },
        ],
      },
    ]);

    const selection = selectFocusedSources(
      snapshot,
      "Can I withdraw my enrollment? If not, file a tuition appeal.",
      undefined,
      {
        primaryActionPurpose: "withdraw enrollment",
        alternativeActionPurposes: ["file tuition appeal"],
      },
    );
    const blockIds = selectedBlockIds(selection);

    expect(selection.coverage).toBe("complete");
    expect(blockIds).toContain("block_withdrawpermit1");
    expect(blockIds).toContain("block_withdrawscope1");
    expect(blockIds).toContain("block_exceptionrule1");
    expect(blockIds).toContain("block_appealpermit1");
    expect(selection.pages.map((page) => page.pageId)).not.toContain("page_catering1");
  });

  it("does not claim complete operative coverage from a heading, teaser, and action label", () => {
    const snapshot = syntheticSnapshot("parking", [
      {
        id: "page_parkingappeal1",
        path: "/appeals",
        title: "Parking permit appeals",
        blocks: [
          { id: "block_appealheading1", text: "Appeal a parking permit decision" },
          {
            id: "block_appealteaser1",
            text: "Learn when a parking permit can be appealed and how decisions work.",
          },
        ],
        actions: [
          { id: "action_parkingappeal1", kind: "button", label: "Appeal permit" },
        ],
      },
    ]);

    const selection = selectFocusedSources(
      snapshot,
      "Appeal my parking permit decision.",
      undefined,
      { primaryActionPurpose: "appeal parking permit", alternativeActionPurposes: [] },
    );

    expect(selectedActionIds(selection)).toContain("action_parkingappeal1");
    expect(selection.coverage).toBe("incomplete");
    expect(selection.limitations).toContain(
      "No selected operative policy evidence matched the primary goal-scoped action purpose.",
    );
  });

  it("keeps genuinely absent policy unresolved instead of inferring it from an observed control", () => {
    const snapshot = syntheticSnapshot("records", [
      {
        id: "page_recordsrequest1",
        path: "/records",
        title: "Records desk",
        blocks: [{ id: "block_recordsintro1", text: "Records request service" }],
        actions: [
          { id: "action_recordsrequest1", kind: "button", label: "Request correction" },
        ],
      },
    ]);

    const selection = selectFocusedSources(
      snapshot,
      "Request a correction to my record.",
      undefined,
      { primaryActionPurpose: "request correction", alternativeActionPurposes: [] },
    );

    expect(selection.coverage).toBe("incomplete");
    expect(selection.semanticCoverage).toBe("not_verified");
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
      "No selected operative policy evidence matched the primary goal-scoped action purpose.",
    ]));
  });
});
