import { describe, expect, it } from "vitest";

import {
  ProcedureModelSchema,
  SiteSnapshotSchema,
  UserFactDefinitionSchema,
} from "../../src/contracts/index.js";
import {
  convertCompactExtraction,
  type CompactExtractionDTO,
} from "../../src/extractor/compact.js";
import { baseProcedureModelFixture, baseSnapshotFixture } from "../fixtures/p0.js";
import { compactFixtureFromModel } from "./compact-fixture.js";

const snapshot = SiteSnapshotSchema.parse(baseSnapshotFixture);

function freshDto(): CompactExtractionDTO {
  return structuredClone(compactFixtureFromModel(baseProcedureModelFixture));
}

function ruleById(dto: CompactExtractionDTO, id: string): CompactExtractionDTO["rules"][number] {
  const rule = dto.rules.find((candidate) => candidate.id === id);
  if (rule === undefined) throw new TypeError(`Missing compact rule ${id}`);
  return rule;
}

function actionById(dto: CompactExtractionDTO, id: string): CompactExtractionDTO["actions"][number] {
  const action = dto.actions.find((candidate) => candidate.id === id);
  if (action === undefined) throw new TypeError(`Missing compact action ${id}`);
  return action;
}

describe("compact extraction conversion", () => {
  it("deterministically converts a valid DTO to the canonical ProcedureModel", () => {
    const dto = freshDto();
    const first = convertCompactExtraction(dto, snapshot);
    const second = convertCompactExtraction(dto, snapshot);

    expect(first).toEqual(second);
    expect(first).toEqual({
      ok: true,
      model: ProcedureModelSchema.parse(baseProcedureModelFixture),
      normalizations: [],
    });
    if (!first.ok) return;
    const openRule = first.model.rules.find((rule) => rule.id === "rule_openpermit1");
    expect(openRule?.actionId).toBe("proc_open001");
    expect(openRule?.citations[0]?.actionIds).toEqual(["action_open001"]);
  });

  it("rejects a ProcedureAction ID used in a citation WebsiteAction field", () => {
    const dto = freshDto();
    ruleById(dto, "rule_openpermit1").citations[0] = {
      pageId: "page_policy001",
      pageUrl: "https://northstar.test/help/transfers",
      blockId: "block_procedure1",
      excerpt: "Open the transfer details and choose Cancel transfer to cancel an eligible transfer.",
      websiteActionIds: ["proc_open001"],
    };

    const outcome = convertCompactExtraction(dto, snapshot);
    expect(outcome).toMatchObject({ ok: false, stage: "conversion" });
    if (outcome.ok) return;
    expect(outcome.issues).toContain(
      "Rule rule_openpermit1 citation uses procedure action proc_open001 where a WebsiteAction ID is required.",
    );
  });

  it("preserves a citation-only informational WebsiteAction without fabricating a procedure action", () => {
    const dto = freshDto();
    actionById(dto, "proc_open001").websiteActionId = "action_cancel01";
    const originalActionCount = dto.actions.length;

    const outcome = convertCompactExtraction(dto, snapshot);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.model.rules.find((rule) => rule.id === "rule_openpermit1")?.citations[0]?.actionIds)
      .toEqual(["action_open001"]);
    expect(outcome.model.actions).toHaveLength(originalActionCount);
    expect(outcome.model.actions.some((action) => action.websiteActionId === "action_open001"))
      .toBe(false);
  });

  it("rejects an observed WebsiteAction from a different page than the citation", () => {
    const dto = freshDto();
    const rule = ruleById(dto, "rule_cancelpermit1");
    const citation = rule.citations[0];
    if (citation === undefined) throw new TypeError("Missing compact citation");
    citation.websiteActionIds = ["action_recover1"];

    const outcome = convertCompactExtraction(dto, snapshot);
    expect(outcome).toMatchObject({ ok: false, stage: "conversion" });
    if (outcome.ok) return;
    expect(outcome.issues).toContain(
      "Rule rule_cancelpermit1 citation WebsiteAction action_recover1 belongs to page page_transfer01, not cited page page_policy001.",
    );
  });

  it("treats the boolean empty-array sentinel as omitted canonical allowedValues", () => {
    const dto = freshDto();
    const definition = dto.factDefinitions.find((fact) => fact.key === "verification.begun");
    if (definition === undefined) throw new TypeError("Missing boolean fact definition");
    definition.allowedValuesJson = "[]";

    const outcome = convertCompactExtraction(dto, snapshot);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.model.factDefinitions.find((fact) => fact.key === definition.key))
      .toEqual({
        key: definition.key,
        label: definition.label,
        type: "boolean",
        sensitive: false,
      });
  });

  it("preserves a valid boolean enumeration when one is explicitly supplied", () => {
    const dto = freshDto();
    const definition = dto.factDefinitions.find((fact) => fact.key === "verification.begun");
    if (definition === undefined) throw new TypeError("Missing boolean fact definition");
    definition.allowedValuesJson = "[true,false]";

    const outcome = convertCompactExtraction(dto, snapshot);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.model.factDefinitions.find((fact) => fact.key === definition.key)?.allowedValues)
      .toEqual([true, false]);
  });

  it("rejects malformed, wrong-type, and non-boolean empty allowed-value arrays", () => {
    const malformed = freshDto();
    const malformedFact = malformed.factDefinitions.find((fact) => fact.key === "verification.begun");
    if (malformedFact === undefined) throw new TypeError("Missing boolean fact definition");
    malformedFact.allowedValuesJson = "not-json";
    const malformedOutcome = convertCompactExtraction(malformed, snapshot);
    expect(malformedOutcome).toMatchObject({ ok: false, stage: "conversion" });
    if (malformedOutcome.ok) return;
    expect(malformedOutcome.issues).toContain(
      "factDefinitions.verification.begun.allowedValuesJson must contain valid JSON.",
    );

    const wrongType = freshDto();
    const wrongTypeFact = wrongType.factDefinitions.find((fact) => fact.key === "verification.begun");
    if (wrongTypeFact === undefined) throw new TypeError("Missing boolean fact definition");
    wrongTypeFact.allowedValuesJson = '["true","false"]';
    const wrongTypeOutcome = convertCompactExtraction(wrongType, snapshot);
    expect(wrongTypeOutcome).toMatchObject({ ok: false, stage: "conversion" });
    if (wrongTypeOutcome.ok) return;
    expect(wrongTypeOutcome.issues).toContain(
      "Allowed values do not match the declared type of verification.begun.",
    );

    const emptyStringEnum = freshDto();
    const stringFact = emptyStringEnum.factDefinitions.find((fact) => fact.key === "payment.status");
    if (stringFact === undefined) throw new TypeError("Missing string fact definition");
    stringFact.allowedValuesJson = "[]";
    const emptyStringOutcome = convertCompactExtraction(emptyStringEnum, snapshot);
    expect(emptyStringOutcome).toMatchObject({ ok: false, stage: "conversion" });
    if (emptyStringOutcome.ok) return;
    expect(emptyStringOutcome.issues).toContain(
      "factDefinitions.payment.status.allowedValuesJson must encode a non-empty scalar array.",
    );
  });

  it("keeps absent number enumerations optional and canonical parsing strict", () => {
    const dto = freshDto();
    dto.factDefinitions.push({
      key: "transfer.amount",
      label: "Transfer amount",
      type: "number",
      allowedValuesJson: "",
      sensitive: false,
    });

    const outcome = convertCompactExtraction(dto, snapshot);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.model.factDefinitions.find((fact) => fact.key === "transfer.amount"))
      .toEqual({
        key: "transfer.amount",
        label: "Transfer amount",
        type: "number",
        sensitive: false,
      });
    expect(UserFactDefinitionSchema.safeParse({
      key: "flag",
      label: "Flag",
      type: "boolean",
      allowedValues: [],
      sensitive: false,
    }).success).toBe(false);
    expect(UserFactDefinitionSchema.safeParse({
      key: "flag",
      label: "Flag",
      type: "boolean",
      sensitive: false,
      unexpected: true,
    }).success).toBe(false);
  });

  it("separates a page-A policy citation from its page-B target procedure action", () => {
    const dto = freshDto();
    const rule = ruleById(dto, "rule_cancelpermit1");
    const citation = rule.citations[0];
    if (citation === undefined) throw new TypeError("Missing compact citation");
    citation.websiteActionIds = ["action_cancel01"];

    const outcome = convertCompactExtraction(dto, snapshot);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.normalizations).toEqual([
      expect.objectContaining({
        code: "CROSS_PAGE_TARGET_ACTION_OMITTED",
        ruleId: "rule_cancelpermit1",
        citationPageId: "page_policy001",
        websiteActionId: "action_cancel01",
        websiteActionPageId: "page_transfer01",
      }),
    ]);
    expect(outcome.model.actions.find((action) => action.id === "proc_cancel01")?.websiteActionId)
      .toBe("action_cancel01");
    expect(outcome.model.rules.find((candidate) => candidate.id === rule.id)?.citations[0])
      .toMatchObject({ pageId: "page_policy001", blockId: "block_general01", actionIds: [] });
  });

  it("accepts an empty action list for cross-page policy evidence without changing provenance", () => {
    const outcome = convertCompactExtraction(freshDto(), snapshot);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const action = outcome.model.actions.find((candidate) => candidate.id === "proc_cancel01");
    const rule = outcome.model.rules.find((candidate) => candidate.id === "rule_cancelpermit1");
    expect(action?.websiteActionId).toBe("action_cancel01");
    expect(rule?.citations[0]).toMatchObject({
      pageId: "page_policy001",
      blockId: "block_general01",
      actionIds: [],
    });
    expect(outcome.normalizations).toEqual([]);
  });

  it("diagnoses missing and empty rule condition roots without substituting always", () => {
    const missingDto = freshDto();
    ruleById(missingDto, "rule_instantdeny1").appliesWhenConditionId = "condition_missing_root";
    const missingOutcome = convertCompactExtraction(missingDto, snapshot);
    expect(missingOutcome).toMatchObject({ ok: false, stage: "conversion" });
    if (missingOutcome.ok) return;
    expect(missingOutcome.issues).toContain(
      'Rule rule_instantdeny1 appliesWhenConditionId references unknown condition node "condition_missing_root".',
    );

    const emptyDto = freshDto();
    ruleById(emptyDto, "rule_instantdeny1").appliesWhenConditionId = "";
    const emptyOutcome = convertCompactExtraction(emptyDto, snapshot);
    expect(emptyOutcome).toMatchObject({ ok: false, stage: "conversion" });
    if (emptyOutcome.ok) return;
    expect(emptyOutcome.issues).toContain(
      "Rule rule_instantdeny1 appliesWhenConditionId is empty; expected a condition node ID.",
    );
  });

  it("preserves prohibitions, unknown user facts, dependencies, and exact citations", () => {
    const outcome = convertCompactExtraction(freshDto(), snapshot);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const prohibition = outcome.model.rules.find((rule) => rule.id === "rule_instantdeny1");
    expect(prohibition).toMatchObject({ effect: "prohibit" });
    expect(prohibition?.appliesWhen).toEqual({
      kind: "all",
      conditions: [
        { kind: "fact", fact: "payment.method", op: "eq", value: "instant" },
        { kind: "fact", fact: "verification.begun", op: "eq", value: true },
      ],
    });
    expect(outcome.model.actions.find((action) => action.id === "proc_cancel01")?.prerequisiteActionIds)
      .toEqual(["proc_open001"]);
    expect(prohibition?.citations).toEqual(baseProcedureModelFixture.rules[2]?.citations);
  });

  it("preserves nested all, any, and not exception semantics", () => {
    const dto = freshDto();
    const cancelRule = ruleById(dto, "rule_cancelpermit1");
    const originalRootId = cancelRule.appliesWhenConditionId;
    dto.conditionNodes.push(
      {
        id: "condition_exception_fact",
        kind: "fact",
        fact: "payment.method",
        op: "eq",
        valueJson: JSON.stringify("instant"),
        childIds: [],
      },
      {
        id: "condition_exception_not",
        kind: "not",
        fact: "",
        op: "",
        valueJson: "",
        childIds: ["condition_exception_fact"],
      },
      {
        id: "condition_exception_any",
        kind: "any",
        fact: "",
        op: "",
        valueJson: "",
        childIds: [originalRootId, "condition_exception_not"],
      },
    );
    cancelRule.appliesWhenConditionId = "condition_exception_any";

    const outcome = convertCompactExtraction(dto, snapshot);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const converted = outcome.model.rules.find((rule) => rule.id === cancelRule.id);
    expect(converted?.appliesWhen.kind).toBe("any");
    expect(converted?.appliesWhen).toMatchObject({
      kind: "any",
      conditions: [
        { kind: "all" },
        {
          kind: "not",
          condition: { kind: "fact", fact: "payment.method", op: "eq", value: "instant" },
        },
      ],
    });
  });

  it("rejects unsupported website actions and pages instead of repairing them", () => {
    const actionDto = freshDto();
    const action = actionDto.actions.find((candidate) => candidate.id === "proc_cancel01");
    if (action === undefined) throw new TypeError("Missing compact action");
    action.websiteActionId = "action_invented1";

    const actionOutcome = convertCompactExtraction(actionDto, snapshot);
    expect(actionOutcome).toMatchObject({ ok: false });
    if (actionOutcome.ok) return;
    expect(actionOutcome.issues).toContain(
      "Action proc_cancel01 references unsupported website action action_invented1.",
    );

    const pageDto = freshDto();
    ruleById(pageDto, "rule_cancelpermit1").citations[0] = {
      pageId: "page_invented1",
      pageUrl: "https://northstar.test/invented",
      blockId: "block_general01",
      excerpt: "Scheduled transfers may be canceled before processing begins.",
      websiteActionIds: [],
    };
    const pageOutcome = convertCompactExtraction(pageDto, snapshot);
    expect(pageOutcome).toMatchObject({ ok: false });
    if (pageOutcome.ok) return;
    expect(pageOutcome.issues).toContain(
      "Rule rule_cancelpermit1 references unsupported page page_invented1.",
    );
  });

  it("rejects malformed fact expressions and never replaces them with always", () => {
    const dto = freshDto();
    const factNode = dto.conditionNodes.find((node) => node.kind === "fact");
    if (factNode === undefined) throw new TypeError("Missing compact fact node");
    factNode.valueJson = "not-json";

    const outcome = convertCompactExtraction(dto, snapshot);
    expect(outcome).toMatchObject({ ok: false });
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.includes("must contain valid JSON"))).toBe(true);
  });

  it("rejects condition cycles", () => {
    const dto = freshDto();
    dto.conditionNodes.push(
      { id: "condition_cycle_a", kind: "not", fact: "", op: "", valueJson: "", childIds: ["condition_cycle_b"] },
      { id: "condition_cycle_b", kind: "not", fact: "", op: "", valueJson: "", childIds: ["condition_cycle_a"] },
    );

    const outcome = convertCompactExtraction(dto, snapshot);
    expect(outcome).toMatchObject({ ok: false });
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.includes("Condition cycle"))).toBe(true);
  });

  it("rejects more than four compound condition levels without truncating", () => {
    const dto = freshDto();
    dto.conditionNodes.push({
      id: "condition_depth_leaf",
      kind: "always",
      fact: "",
      op: "",
      valueJson: "",
      childIds: [],
    });
    let childId = "condition_depth_leaf";
    for (let depth = 1; depth <= 5; depth += 1) {
      const id = `condition_depth_${depth}`;
      dto.conditionNodes.push({ id, kind: "not", fact: "", op: "", valueJson: "", childIds: [childId] });
      childId = id;
    }
    ruleById(dto, "rule_openpermit1").appliesWhenConditionId = childId;

    const outcome = convertCompactExtraction(dto, snapshot);
    expect(outcome).toMatchObject({ ok: false });
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.includes("exceeds 4 compound levels"))).toBe(true);
  });

  it("rejects a stale prerequisite alias after a procedure action was renamed", () => {
    const dto = freshDto();
    dto.actions.push(
      {
        id: "action_view_transfer_001",
        kind: "navigate",
        label: "View transfer details page",
        description: "Open the observed transfer details page.",
        websiteActionId: "action_open001",
        prerequisiteActionIds: [],
        terminal: false,
      },
      {
        id: "action_confirm_transfer_type_001",
        kind: "user_task",
        label: "Confirm transfer type",
        description: "Confirm the transfer type from the details page or email.",
        websiteActionId: "",
        prerequisiteActionIds: ["action_view_transfer_details"],
        terminal: false,
      },
    );

    const outcome = convertCompactExtraction(dto, snapshot);

    expect(outcome).toMatchObject({
      ok: false,
      stage: "canonical_schema",
      issues: ["root: Unknown prerequisite action: action_view_transfer_details"],
      normalizations: [],
    });
    expect(dto.actions.at(-1)?.prerequisiteActionIds).toEqual(["action_view_transfer_details"]);
  });

  it("rejects malformed effect-specific fields and missing canonical evidence", () => {
    const effectDto = freshDto();
    ruleById(effectDto, "rule_instantdeny1").requiredActionId = "proc_open001";
    const effectOutcome = convertCompactExtraction(effectDto, snapshot);
    expect(effectOutcome).toMatchObject({ ok: false });

    const evidenceDto = freshDto();
    ruleById(evidenceDto, "rule_cancelpermit1").citations = [];
    const evidenceOutcome = convertCompactExtraction(evidenceDto, snapshot);
    expect(evidenceOutcome).toMatchObject({ ok: false });
  });
});
