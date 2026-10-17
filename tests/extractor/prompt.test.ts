import { describe, expect, it } from "vitest";

import { POLICY_EXTRACTION_SYSTEM_PROMPT } from "../../src/extractor/index.js";

describe("Stage 1 policy extraction prompt", () => {
  it("distinguishes action eligibility from eventual outcomes", () => {
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "identify the exact action whose initiation the source authorizes",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "Keep permission to initiate that action separate from eligibility conditions",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "permission to appeal is not a likelihood of winning",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "Never assert that an outcome will occur merely because submission or initiation is permitted",
    );
  });

  it("preserves genuinely uncertain eligibility without treating every hedge as permission", () => {
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "Hedging attached to eligibility, such as \"may be eligible\"",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "Do not treat every use of \"may\" as universal permission",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "set needsReview=true with a precise eligibility-focused reviewReason",
    );
  });

  it("does not turn negative outcome guarantees into eligibility conditions", () => {
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "is not by itself an eligibility condition, a missing eligibility condition, or a reason to mark",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "Do not convert an optional or uncertain outcome into an eligibility predicate",
    );
  });

  it("keeps mandatory user facts in applicability conditions", () => {
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "Preserve every mandatory eligibility qualifier in appliesWhenConditionId",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "including user facts whose values are not yet known",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "Never broaden a rule by omitting a qualifier",
    );
  });

  it("keeps prerequisites available for dependency mapping instead of inventing permission", () => {
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "Preserve them as require_condition or require_action rules",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "Stage 2 can map action prerequisites and dependencies",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "do not invent them as permission conditions",
    );
  });

  it("does not infer permission from examples, navigation, or operational availability", () => {
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "Examples, navigation labels, and the mere existence of a page, form, or control do not establish permission",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "Keep review when the evidence needed to determine action eligibility is absent",
    );
  });
});
