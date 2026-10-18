import { describe, expect, it } from "vitest";

import { ProcedureModelSchema, SiteSnapshotSchema, hashText } from "../../src/contracts/index.js";
import { evaluateCondition } from "../../src/engine/index.js";
import {
  convertStagedExtraction,
  normalizeStagedRuleIds,
  replayStagedExtraction,
  selectFocusedSources,
  validatePolicyExtraction,
  validateProcedureMapping,
} from "../../src/extractor/index.js";
import { baseProcedureModelFixture, baseSnapshotFixture } from "../fixtures/p0.js";
import { stagedFixturesFromModel } from "./compact-fixture.js";

const GOAL = "Cancel a transfer or request recovery.";
const snapshot = SiteSnapshotSchema.parse(baseSnapshotFixture);
const catalog = selectFocusedSources(snapshot, GOAL);

function stages() {
  return structuredClone(stagedFixturesFromModel(baseProcedureModelFixture));
}

function qualifiedCancellationScenario() {
  const text = "A scheduled standard transfer may be canceled before processing begins.";
  const qualifiedSnapshot = SiteSnapshotSchema.parse({
    ...baseSnapshotFixture,
    pages: baseSnapshotFixture.pages.map((page) =>
      page.id !== "page_policy001"
        ? page
        : {
            ...page,
            blocks: page.blocks.map((block) =>
              block.id === "block_general01" ? { ...block, text, textHash: hashText(text) } : block,
            ),
          },
    ),
  });
  const fixture = stages();
  const rule = fixture.policy.rules.find((candidate) => candidate.id === "rule_cancelpermit1");
  const root = fixture.policy.conditionNodes.find(
    (candidate) => candidate.id === rule?.appliesWhenConditionId,
  );
  if (rule === undefined || root === undefined || root.kind !== "all" || rule.citations[0] === undefined) {
    throw new TypeError("Missing compound cancellation fixture");
  }
  rule.citations[0].excerpt = text;
  fixture.policy.conditionNodes.push({
    id: "condition_standard01",
    kind: "fact",
    fact: "payment.method",
    op: "eq",
    valueJson: '"standard"',
    childIds: [],
  });
  root.childIds.push("condition_standard01");
  rule.qualifierConditionIds.push("condition_standard01");
  return {
    fixture,
    rule,
    snapshot: qualifiedSnapshot,
    catalog: selectFocusedSources(qualifiedSnapshot, GOAL),
  };
}

describe("two-stage deterministic conversion", () => {
  it("deterministically normalizes unique internal rule IDs and preserves policy semantics", () => {
    const fixture = stages();
    const originalRule = fixture.policy.rules[0]!;
    const originalId = originalRule.id;
    const mapping = fixture.mapping.ruleMappings.find(
      (candidate) => candidate.policyRuleId === originalId,
    );
    if (mapping === undefined) throw new TypeError("Missing rule mapping fixture");
    originalRule.id = "r1_invalid_but_unique";
    mapping.policyRuleId = originalRule.id;
    const originalSemantics = { ...structuredClone(originalRule), id: undefined };

    const normalized = normalizeStagedRuleIds(fixture.policy, fixture.mapping);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.policy).toEqual({
      ...fixture.policy,
      rules: fixture.policy.rules.map((rule) => ({
        ...rule,
        id: rule.id === "r1_invalid_but_unique" ? "rule_r1_invalid_but_unique" : rule.id,
      })),
    });
    expect(normalized.mapping).toEqual({
      ...fixture.mapping,
      ruleMappings: fixture.mapping.ruleMappings.map((reference) => ({
        ...reference,
        policyRuleId: reference.policyRuleId === "r1_invalid_but_unique"
          ? "rule_r1_invalid_but_unique"
          : reference.policyRuleId,
      })),
    });

    const first = convertStagedExtraction(fixture.policy, fixture.mapping, snapshot, catalog);
    const second = convertStagedExtraction(fixture.policy, fixture.mapping, snapshot, catalog);

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.normalizations).toContainEqual({
      code: "CANONICAL_RULE_ID_NORMALIZED",
      originalRuleId: "r1_invalid_but_unique",
      canonicalRuleId: "rule_r1_invalid_but_unique",
    });
    expect(first.compactDto.rules[0]?.id).toBe("rule_r1_invalid_but_unique");
    const canonicalRule = first.model.rules.find(
      (rule) => rule.id === "rule_r1_invalid_but_unique",
    );
    expect(canonicalRule).toBeDefined();
    if (canonicalRule === undefined) return;
    const { id: _canonicalId, ...canonicalSemantics } = canonicalRule;
    const { actionPurpose: _purpose, qualifierConditionIds: _qualifiers, ...stageSemantics } =
      originalSemantics;
    expect(canonicalSemantics.effect).toBe(stageSemantics.effect);
    expect(canonicalSemantics.actionId).toBe(mapping.actionId);
    expect(canonicalSemantics.semanticConfidence).toBe(stageSemantics.semanticConfidence);
    expect(canonicalSemantics.needsReview).toBe(stageSemantics.needsReview);
    expect(canonicalSemantics.citations).toEqual(
      stageSemantics.citations.map((citation) => ({
        pageId: citation.pageId,
        pageUrl: citation.pageUrl,
        blockId: citation.blockId,
        excerpt: citation.excerpt,
        actionIds: citation.websiteActionIds,
      })),
    );
    expect(ProcedureModelSchema.safeParse(first.model).success).toBe(true);
  });

  it("rejects a canonical rule-ID collision", () => {
    const fixture = stages();
    const firstRule = fixture.policy.rules[0]!;
    const secondRule = fixture.policy.rules[1]!;
    const firstMapping = fixture.mapping.ruleMappings.find(
      (candidate) => candidate.policyRuleId === firstRule.id,
    );
    const secondMapping = fixture.mapping.ruleMappings.find(
      (candidate) => candidate.policyRuleId === secondRule.id,
    );
    if (firstMapping === undefined || secondMapping === undefined) {
      throw new TypeError("Missing collision mapping fixtures");
    }
    firstRule.id = "r1_collision";
    firstMapping.policyRuleId = firstRule.id;
    secondRule.id = "rule_r1_collision";
    secondMapping.policyRuleId = secondRule.id;

    const outcome = normalizeStagedRuleIds(fixture.policy, fixture.mapping);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]).toContain("normalization collision");
  });

  it("normalizes the rule ids recorded from the invalid Sonnet procedure model", () => {
    const recordedIds = [
      "r1_prohibit_cancel_completed",
      "r2_prohibit_cancel_processing_started",
      "r3_permit_cancel_scheduled",
      "r4_permit_recovery_completed_self_initiated",
      "r5_prohibit_recovery_not_initiated",
      "r6_require_recovery_reference_and_recipient",
      "r7_require_recovery_description_and_email",
      "r8_require_instant_completed_before_recovery",
    ] as const;

    for (const recordedId of recordedIds) {
      const fixture = stages();
      const originalRule = fixture.policy.rules[0]!;
      const mapping = fixture.mapping.ruleMappings.find(
        (candidate) => candidate.policyRuleId === originalRule.id,
      );
      if (mapping === undefined) throw new TypeError("Missing rule mapping fixture");
      originalRule.id = recordedId;
      mapping.policyRuleId = recordedId;

      const outcome = convertStagedExtraction(fixture.policy, fixture.mapping, snapshot, catalog);
      expect(outcome.ok, recordedId).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.compactDto.rules[0]?.id).toBe(`rule_${recordedId}`);
      expect(ProcedureModelSchema.safeParse(outcome.model).success).toBe(true);
    }
  });

  it("rejects unknown Stage 2 rule references during normalization", () => {
    const fixture = stages();
    fixture.mapping.ruleMappings[0]!.policyRuleId = "r9_unknown_rule";

    const outcome = normalizeStagedRuleIds(fixture.policy, fixture.mapping);

    expect(outcome).toEqual({
      ok: false,
      issues: ["Cannot normalize unknown Stage 2 policyRuleId \"r9_unknown_rule\"."],
    });
  });

  it("accepts boolean no-enumeration sentinels without changing conditions or qualifiers", () => {
    const fixture = stages();
    const definition = fixture.policy.factDefinitions.find(
      (fact) => fact.key === "verification.begun",
    );
    const prohibition = fixture.policy.rules.find((rule) => rule.id === "rule_instantdeny1");
    if (definition === undefined || prohibition === undefined) {
      throw new TypeError("Missing boolean fact or prohibition fixture");
    }
    definition.allowedValuesJson = "[]";
    const originalConditions = structuredClone(fixture.policy.conditionNodes);
    const originalQualifiers = [...prohibition.qualifierConditionIds];

    const validated = validatePolicyExtraction(fixture.policy, catalog);

    expect(validated.ok).toBe(true);
    expect(fixture.policy.conditionNodes).toEqual(originalConditions);
    expect(prohibition.qualifierConditionIds).toEqual(originalQualifiers);
  });

  it("preserves multiple mandatory permission qualifiers without information loss", () => {
    const scenario = qualifiedCancellationScenario();
    const converted = convertStagedExtraction(
      scenario.fixture.policy,
      scenario.fixture.mapping,
      scenario.snapshot,
      scenario.catalog,
    );

    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    const canonicalRule = converted.model.rules.find(
      (candidate) => candidate.id === scenario.rule.id,
    );
    expect(canonicalRule?.appliesWhen).toMatchObject({ kind: "all" });
    if (canonicalRule?.appliesWhen.kind !== "all") return;
    expect(canonicalRule.appliesWhen.conditions).toHaveLength(3);
    expect(canonicalRule.appliesWhen.conditions).toContainEqual({
      kind: "fact",
      fact: "payment.method",
      op: "eq",
      value: "standard",
    });
  });

  it("preserves an Instant-transfer prohibition alongside a Scheduled permission", () => {
    const fixture = stages();
    const converted = convertStagedExtraction(fixture.policy, fixture.mapping, snapshot, catalog);

    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    expect(converted.model.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "rule_cancelpermit1", effect: "permit" }),
        expect.objectContaining({ id: "rule_instantdeny1", effect: "prohibit" }),
      ]),
    );
    expect(JSON.stringify(converted.model.rules.find((rule) => rule.id === "rule_instantdeny1")))
      .toContain('"value":"instant"');
  });

  it("leaves cancellation indeterminate when the mandatory transfer type is unknown", () => {
    const scenario = qualifiedCancellationScenario();
    const converted = convertStagedExtraction(
      scenario.fixture.policy,
      scenario.fixture.mapping,
      scenario.snapshot,
      scenario.catalog,
    );
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    const rule = converted.model.rules.find((candidate) => candidate.id === scenario.rule.id);
    if (rule === undefined) throw new TypeError("Missing converted cancellation rule");

    const evaluation = evaluateCondition(rule.appliesWhen, {
      "payment.status": "scheduled",
      "payment.beforeDeadline": true,
    });

    expect(evaluation).toEqual({
      value: "unknown",
      missingFacts: ["payment.method"],
      reasonCodes: ["MISSING_FACT"],
    });
  });

  it("preserves a completed-transfer ownership eligibility fact", () => {
    const fixture = stages();
    fixture.policy.factDefinitions.push({
      key: "payment.startedByUser",
      label: "Transfer started by user",
      type: "boolean",
      allowedValuesJson: "",
      sensitive: false,
    });
    const rule = fixture.policy.rules.find((candidate) => candidate.id === "rule_recoverok01");
    if (rule === undefined) throw new TypeError("Missing recovery rule");
    const previousRoot = rule.appliesWhenConditionId;
    fixture.policy.conditionNodes.push(
      {
        id: "condition_owner001",
        kind: "fact",
        fact: "payment.startedByUser",
        op: "eq",
        valueJson: "true",
        childIds: [],
      },
      {
        id: "condition_recoverall",
        kind: "all",
        fact: "",
        op: "",
        valueJson: "",
        childIds: [previousRoot, "condition_owner001"],
      },
    );
    rule.appliesWhenConditionId = "condition_recoverall";
    rule.qualifierConditionIds.push("condition_owner001");

    const converted = convertStagedExtraction(fixture.policy, fixture.mapping, snapshot, catalog);

    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    expect(JSON.stringify(converted.model.rules.find((candidate) => candidate.id === rule.id)))
      .toContain("payment.startedByUser");
  });

  it("rejects a semantically empty require_condition instead of turning a warning into policy", () => {
    const fixture = stages();
    const rule = fixture.policy.rules.find((candidate) => candidate.id === "rule_verifyreq01");
    if (rule === undefined) throw new TypeError("Missing requirement rule");
    fixture.policy.conditionNodes.push({
      id: "condition_alwaysreq",
      kind: "always",
      fact: "",
      op: "",
      valueJson: "",
      childIds: [],
    });
    rule.requirementConditionId = "condition_alwaysreq";

    const result = validatePolicyExtraction(fixture.policy, catalog);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContain(
      "Policy rule rule_verifyreq01 has a semantically empty require_condition requirement.",
    );
  });

  it("rejects dangling prerequisites without inventing or renaming actions", () => {
    const fixture = stages();
    const cancel = fixture.mapping.actions.find((action) => action.id === "proc_cancel01");
    if (cancel === undefined) throw new TypeError("Missing cancellation action");
    cancel.prerequisiteActionIds = ["proc_missing01"];

    const result = validateProcedureMapping(fixture.mapping, fixture.policy, catalog);

    expect(result).toEqual({
      ok: false,
      issues: ["Procedure action proc_cancel01 references undeclared prerequisite proc_missing01."],
    });
    expect(fixture.mapping.actions.some((action) => action.id === "proc_missing01")).toBe(false);
  });

  it("enforces WebsiteAction and ProcedureAction namespace separation", () => {
    const fixture = stages();
    const mapping = fixture.mapping.ruleMappings.find(
      (candidate) => candidate.policyRuleId === "rule_cancelpermit1",
    );
    if (mapping === undefined) throw new TypeError("Missing cancellation mapping");
    mapping.actionId = "action_cancel01";

    const result = validateProcedureMapping(fixture.mapping, fixture.policy, catalog);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContain(
      "Policy rule rule_cancelpermit1 targets undeclared procedure action action_cancel01.",
    );
  });

  it("accepts cross-page policy citations with no citation-local action and preserves action bindings", () => {
    const fixture = stages();
    const rule = fixture.policy.rules.find((candidate) => candidate.id === "rule_cancelpermit1");
    if (rule?.citations[0] === undefined) throw new TypeError("Missing cancellation citation");
    rule.citations[0].websiteActionIds = [];

    const result = convertStagedExtraction(fixture.policy, fixture.mapping, snapshot, catalog);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.rules.find((candidate) => candidate.id === rule.id)?.citations[0]?.actionIds)
      .toEqual([]);
    expect(result.model.actions.find((action) => action.id === "proc_cancel01")?.websiteActionId)
      .toBe("action_cancel01");
  });

  it("preserves exact citations, prohibitions, and alternatives across both stages", () => {
    const fixture = stages();
    const first = convertStagedExtraction(fixture.policy, fixture.mapping, snapshot, catalog);
    const second = replayStagedExtraction(fixture.policy, fixture.mapping, snapshot, catalog);

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.model.rules).toContainEqual(
      expect.objectContaining({ id: "rule_instantdeny1", effect: "prohibit" }),
    );
    expect(first.model.goalActionIds).toEqual(
      expect.arrayContaining(["proc_cancel01", "proc_recover1", "proc_support1"]),
    );
    const cancellation = first.model.rules.find((rule) => rule.id === "rule_cancelpermit1");
    expect(cancellation?.citations[0]).toEqual(baseProcedureModelFixture.rules[1]?.citations[0]);
  });

  it("rejects a Stage 2 omission rather than dropping a Stage 1 prohibition", () => {
    const fixture = stages();
    fixture.mapping.ruleMappings = fixture.mapping.ruleMappings.filter(
      (mapping) => mapping.policyRuleId !== "rule_instantdeny1",
    );

    const result = validateProcedureMapping(fixture.mapping, fixture.policy, catalog);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContain("Stage 2 omitted policy rule rule_instantdeny1.");
  });
});
