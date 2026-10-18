import { describe, expect, it } from "vitest";

import {
  POLICY_EXTRACTION_SYSTEM_PROMPT,
  PROCEDURE_MAPPING_SYSTEM_PROMPT,
} from "../../src/extractor/index.js";

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

  it("separates required information from independently governed actions", () => {
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "Represent it as require_condition over declared non-sensitive facts",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "Do not turn filling a field, supplying an identifier, or answering a question into a separate user_task",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "Required independent actions are genuinely distinct prior procedures",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "They remain subject to independent closed-world authorization",
    );
    expect(PROCEDURE_MAPPING_SYSTEM_PROMPT).toContain(
      "Do not create a user_task, prerequisiteActionIds entry, or requiredActionId",
    );
  });

  it("models whether-answers and alternative identifiers without changing their meaning", () => {
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "require a known answer without requiring a particular value",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "both fact == true and fact == false",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "Never reinterpret \"tell us whether your account is secured\" as \"your account must be secured.\"",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "\"reference number, or date and amount\" must remain an any condition whose second branch is an all condition",
    );
  });

  it("does not permit an always condition to stand in for missing information", () => {
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "Do not use an always requirementConditionId merely to record that information is required",
    );
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "encode the actual non-always fact condition",
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

  it("keeps citation-only provenance separate from procedure actions", () => {
    expect(POLICY_EXTRACTION_SYSTEM_PROMPT).toContain(
      "a citation-only informational link may remain provenance without becoming a ProcedureAction",
    );
    expect(PROCEDURE_MAPPING_SYSTEM_PROMPT).toContain(
      "do not by themselves require matching ProcedureActions",
    );
    expect(PROCEDURE_MAPPING_SYSTEM_PROMPT).toContain(
      "Never add a dummy or unrelated ProcedureAction solely to represent an informational action",
    );
  });

  it("keeps page navigation distinct from policy and procedural prerequisites", () => {
    expect(PROCEDURE_MAPPING_SYSTEM_PROMPT).toContain(
      "Never relabel an informational or policy-help link as navigation to an operational page",
    );
    expect(PROCEDURE_MAPPING_SYSTEM_PROMPT).toContain(
      "Navigation used only to locate a governed control is access guidance",
    );
    expect(PROCEDURE_MAPPING_SYSTEM_PROMPT).toContain(
      "do not represent the navigation as a separately permitted policy action or prerequisite",
    );
    expect(PROCEDURE_MAPPING_SYSTEM_PROMPT).toContain(
      "Never bind a same-page informational link as though it navigates to the page already containing the target control",
    );
    expect(PROCEDURE_MAPPING_SYSTEM_PROMPT).toContain(
      "A policy-mandated prior action must remain represented by the Stage 1 require_action rule",
    );
    expect(PROCEDURE_MAPPING_SYSTEM_PROMPT).toContain(
      "Never invent a missing action, silently drop a genuine prerequisite",
    );
  });
});
