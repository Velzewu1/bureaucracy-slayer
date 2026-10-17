import { describe, expect, it } from "vitest";

import {
  analyzePolicyExtraction,
  type FocusedSourceCatalog,
  type PolicyExtractionDTO,
} from "../../src/extractor/index.js";

const cancelExcerpt =
  "A scheduled standard transfer may be canceled from its transfer details page at any time before processing begins.";
const recoveryExcerpt = "Completed transfers that you started yourself may be eligible.";
const reportExcerpt = "Report a mistaken transfer using the form on the Support page.";

const catalog: FocusedSourceCatalog = {
  sourceSnapshotId: "snapshot_41d0d491900cfebb6179",
  sourceSnapshotHash: "f5da7bac2d0034f4b4b689945047784c9856dfc32bb47ebbdb50354485b8f214",
  userGoal: "Cancel a mistaken transfer or request recovery.",
  coverage: "complete",
  limitations: [],
  originalCounts: { pages: 9, blocks: 126, actions: 107 },
  selectedCounts: { pages: 3, blocks: 4, actions: 3 },
  pages: [
    {
      pageId: "page_e78fd49ae38512a93640",
      url: "http://127.0.0.1:5180/help/transfers",
      canonicalUrl: "http://127.0.0.1:5180/help/transfers",
      title: "Canceling a transfer",
      blocks: [{ blockId: "block_fc059175893c4915951c", text: cancelExcerpt }],
      actions: [],
      selectionReasons: ["policy evidence"],
    },
    {
      pageId: "page_3a3e5e3ef9304b5db72a",
      url: "http://127.0.0.1:5180/help/recovery",
      canonicalUrl: "http://127.0.0.1:5180/help/recovery",
      title: "Recovering a completed transfer",
      blocks: [
        { blockId: "block_4b3e165045ebe5b2a429", text: recoveryExcerpt },
        { blockId: "block_53939bf8756be232b50e", text: "A recovery request requires:" },
        { blockId: "block_7b27d05810acaa262c77", text: reportExcerpt },
      ],
      actions: [],
      selectionReasons: ["policy evidence"],
    },
    {
      pageId: "page_5476315a05ac57b0f1eb",
      url: "http://127.0.0.1:5180/transfers/tx-001",
      canonicalUrl: "http://127.0.0.1:5180/transfers/tx-001",
      title: "Transfer details",
      blocks: [],
      actions: [
        {
          websiteActionId: "action_cec971f543cc085511e5",
          pageId: "page_5476315a05ac57b0f1eb",
          kind: "button",
          label: "Cancel transfer",
          visible: true,
          enabled: true,
          reversible: false,
        },
        {
          websiteActionId: "action_d0e7c3a4299e5922a954",
          pageId: "page_5476315a05ac57b0f1eb",
          kind: "link",
          label: "Request recovery of a completed transfer",
          visible: true,
          enabled: true,
          reversible: true,
        },
        {
          websiteActionId: "action_edfd7ffe93ae394f03bf",
          pageId: "page_5476315a05ac57b0f1eb",
          kind: "link",
          label: "Report a mistaken transfer",
          visible: true,
          enabled: true,
          reversible: true,
        },
      ],
      selectionReasons: ["procedure page"],
    },
  ],
};

function savedStage1Structure(): PolicyExtractionDTO {
  return {
    schemaVersion: 1,
    policyAnalysisId: "pa_policy_transfer_recovery_q1_2026",
    sourceSnapshotId: catalog.sourceSnapshotId,
    sourceSnapshotHash: catalog.sourceSnapshotHash,
    factDefinitions: [
      { key: "transfer_status", label: "Transfer status", type: "string", allowedValuesJson: '["scheduled","completed"]', sensitive: false },
      { key: "transfer_type", label: "Transfer type", type: "string", allowedValuesJson: '["standard","instant"]', sensitive: false },
      { key: "processing_begun", label: "Processing begun", type: "boolean", allowedValuesJson: "[true,false]", sensitive: false },
      { key: "user_initiated", label: "User initiated", type: "boolean", allowedValuesJson: "[true,false]", sensitive: false },
      { key: "mistaken_transfer", label: "Mistaken transfer", type: "boolean", allowedValuesJson: "[true,false]", sensitive: false },
    ],
    conditionNodes: [
      { id: "cond_always", kind: "always", fact: "", op: "", valueJson: "", childIds: [] },
      { id: "cond_scheduled_standard", kind: "all", fact: "", op: "", valueJson: "", childIds: ["cond_status_scheduled", "cond_type_standard"] },
      { id: "cond_status_scheduled", kind: "fact", fact: "transfer_status", op: "eq", valueJson: '"scheduled"', childIds: [] },
      { id: "cond_type_standard", kind: "fact", fact: "transfer_type", op: "eq", valueJson: '"standard"', childIds: [] },
      { id: "cond_before_processing", kind: "fact", fact: "processing_begun", op: "eq", valueJson: "false", childIds: [] },
      { id: "cond_completed", kind: "fact", fact: "transfer_status", op: "eq", valueJson: '"completed"', childIds: [] },
      { id: "cond_user_initiated", kind: "fact", fact: "user_initiated", op: "eq", valueJson: "true", childIds: [] },
      { id: "cond_completed_user", kind: "all", fact: "", op: "", valueJson: "", childIds: ["cond_completed", "cond_user_initiated"] },
      { id: "cond_mistaken", kind: "fact", fact: "mistaken_transfer", op: "eq", valueJson: "true", childIds: [] },
    ],
    rules: [
      {
        id: "rule_cancel_scheduled_standard",
        effect: "permit",
        actionPurpose: "cancel a scheduled standard transfer before processing begins",
        appliesWhenConditionId: "cond_scheduled_standard",
        requirementConditionId: "cond_before_processing",
        requiredActionPurpose: "",
        qualifierConditionIds: ["cond_status_scheduled", "cond_type_standard", "cond_before_processing"],
        citations: [{ pageId: "page_e78fd49ae38512a93640", pageUrl: "http://127.0.0.1:5180/help/transfers", blockId: "block_fc059175893c4915951c", excerpt: cancelExcerpt, websiteActionIds: ["action_cec971f543cc085511e5"] }],
        semanticConfidence: 0.99,
        needsReview: false,
        reviewReason: "",
      },
      {
        id: "rule_recovery_eligible_completed_user_initiated",
        effect: "permit",
        actionPurpose: "request recovery",
        appliesWhenConditionId: "cond_completed_user",
        requirementConditionId: "",
        requiredActionPurpose: "",
        qualifierConditionIds: ["cond_completed", "cond_user_initiated"],
        citations: [{ pageId: "page_3a3e5e3ef9304b5db72a", pageUrl: "http://127.0.0.1:5180/help/recovery", blockId: "block_4b3e165045ebe5b2a429", excerpt: recoveryExcerpt, websiteActionIds: ["action_d0e7c3a4299e5922a954"] }],
        semanticConfidence: 0.99,
        needsReview: false,
        reviewReason: "",
      },
      {
        id: "rule_recovery_requires_reference_and_recipient_info",
        effect: "require_condition",
        actionPurpose: "submit a payment recovery request",
        appliesWhenConditionId: "cond_completed_user",
        requirementConditionId: "cond_always",
        requiredActionPurpose: "provide transaction reference and recipient information",
        qualifierConditionIds: ["cond_completed", "cond_user_initiated"],
        citations: [{ pageId: "page_3a3e5e3ef9304b5db72a", pageUrl: "http://127.0.0.1:5180/help/recovery", blockId: "block_53939bf8756be232b50e", excerpt: "A recovery request requires:", websiteActionIds: [] }],
        semanticConfidence: 0.99,
        needsReview: false,
        reviewReason: "",
      },
      {
        id: "rule_mistaken_transfer_report_alternative",
        effect: "permit",
        actionPurpose: "report a mistaken transfer",
        appliesWhenConditionId: "cond_mistaken",
        requirementConditionId: "",
        requiredActionPurpose: "",
        qualifierConditionIds: ["cond_mistaken"],
        citations: [{ pageId: "page_3a3e5e3ef9304b5db72a", pageUrl: "http://127.0.0.1:5180/help/recovery", blockId: "block_7b27d05810acaa262c77", excerpt: reportExcerpt, websiteActionIds: ["action_edfd7ffe93ae394f03bf"] }],
        semanticConfidence: 0.95,
        needsReview: false,
        reviewReason: "",
      },
    ],
  };
}

describe("saved live Stage 1 regression", () => {
  it("normalizes only impossible cross-page citation bindings and preserves semantic failures", () => {
    const dto = savedStage1Structure();
    const analysis = analyzePolicyExtraction(dto, catalog);

    expect(analysis.ok).toBe(false);
    expect(analysis.normalizations).toHaveLength(3);
    expect(analysis.normalizations.map((item) => item.websiteActionId)).toEqual([
      "action_cec971f543cc085511e5",
      "action_d0e7c3a4299e5922a954",
      "action_edfd7ffe93ae394f03bf",
    ]);
    if (analysis.ok || analysis.normalizedDto === undefined) return;
    expect(analysis.issues).toEqual([
      "Policy rule rule_cancel_scheduled_standard must leave effect-specific fields empty.",
      "Policy rule rule_cancel_scheduled_standard qualifier cond_before_processing is not reachable from the rule roots.",
      "Policy rule rule_recovery_requires_reference_and_recipient_info must provide only requirementConditionId for require_condition.",
      "Policy rule rule_recovery_requires_reference_and_recipient_info has a semantically empty require_condition requirement.",
    ]);
    expect(analysis.normalizedDto.rules.flatMap((rule) => rule.citations).flatMap((citation) => citation.websiteActionIds))
      .toEqual([]);
    expect(dto.rules[0]?.citations[0]?.websiteActionIds).toEqual(["action_cec971f543cc085511e5"]);
  });

  it("does not normalize an invented citation action", () => {
    const dto = savedStage1Structure();
    const citation = dto.rules[0]?.citations[0];
    if (citation === undefined) throw new TypeError("Missing cancellation citation");
    citation.websiteActionIds = ["action_invented001"];

    const analysis = analyzePolicyExtraction(dto, catalog);

    expect(analysis.normalizations).toHaveLength(2);
    expect(analysis.normalizations.some((item) => item.websiteActionId === "action_invented001"))
      .toBe(false);
    expect(analysis.ok).toBe(false);
    if (analysis.ok) return;
    expect(analysis.issues).toContain(
      "Policy rule rule_cancel_scheduled_standard citation WebsiteAction action_invented001 is not on cited page page_e78fd49ae38512a93640.",
    );
  });
});
