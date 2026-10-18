import { describe, expect, it } from "vitest";

import {
  ProcedureModelSchema,
  UserStateSchema,
  hashCanonical,
  type JsonScalar,
} from "../../src/contracts/index.js";
import { evaluatePolicies, planActions } from "../../src/engine/index.js";
import { validateEvidence } from "../../src/evidence/index.js";
import { baseProcedureModelFixture, baseSnapshotFixture } from "../fixtures/p0.js";

function goalScopedModel() {
  const source = structuredClone(baseProcedureModelFixture);
  const factDefinitions: unknown[] = [
    ...source.factDefinitions.map((definition) =>
      definition.key === "payment.status"
        ? { ...definition, allowedValues: ["scheduled", "processing", "completed"] }
        : definition,
    ),
    {
      key: "transfer.processingBegun",
      label: "Processing begun",
      type: "boolean",
      sensitive: false,
    },
    {
      key: "recovery.eligible",
      label: "Recovery eligibility",
      type: "boolean",
      sensitive: false,
    },
  ];
  const rules = source.rules.map((rule) => {
    if (rule.id === "rule_cancelpermit1") {
      return {
        ...rule,
        appliesWhen: {
          kind: "all" as const,
          conditions: [
            { kind: "fact" as const, fact: "payment.status", op: "eq" as const, value: "scheduled" },
            { kind: "fact" as const, fact: "payment.method", op: "eq" as const, value: "standard" },
            {
              kind: "fact" as const,
              fact: "transfer.processingBegun",
              op: "eq" as const,
              value: false,
            },
          ],
        },
      };
    }
    if (rule.id === "rule_instantdeny1") {
      return {
        ...rule,
        appliesWhen: {
          kind: "fact" as const,
          fact: "payment.method",
          op: "eq" as const,
          value: "instant",
        },
      };
    }
    if (rule.id === "rule_recoverok01") {
      return {
        ...rule,
        appliesWhen: {
          kind: "all" as const,
          conditions: [
            { kind: "fact" as const, fact: "payment.status", op: "eq" as const, value: "completed" },
            { kind: "fact" as const, fact: "recovery.eligible", op: "eq" as const, value: true },
          ],
        },
      };
    }
    return rule;
  });
  return ProcedureModelSchema.parse({
    ...source,
    id: "procedure_goalscope1",
    factDefinitions,
    rules,
  });
}

function evaluate(facts: Readonly<Record<string, JsonScalar>>) {
  const model = goalScopedModel();
  const validation = validateEvidence(baseSnapshotFixture, model, {
    evidenceResultId: "evidence_goalscope1",
    checkedAt: "2026-10-17T12:00:00.000Z",
  });
  if (!validation.ok) throw new TypeError(validation.issues.join("; "));
  const state = UserStateSchema.parse({ schemaVersion: 1, revision: 1, facts });
  const evaluation = evaluatePolicies(model, validation.evidence, state);
  const plan = planActions(model, validation.evidence, evaluation, state, {
    planId: "plan_goalscope001",
    generatedAt: "2026-10-17T12:01:00.000Z",
    userStateHash: hashCanonical(state),
  });
  return { model, evidence: validation.evidence, evaluation, plan };
}

function facts(overrides: Readonly<Record<string, JsonScalar>> = {}): Record<string, JsonScalar> {
  return {
    "payment.status": "scheduled",
    "payment.method": "standard",
    "transfer.processingBegun": false,
    "payment.beforeDeadline": true,
    "verification.begun": false,
    "verification.complete": true,
    "recovery.eligible": false,
    ...overrides,
  };
}

function decision(
  result: ReturnType<typeof evaluate>,
  actionId: "proc_cancel01" | "proc_recover1",
) {
  const found = result.evaluation.decisions.find((candidate) => candidate.actionId === actionId);
  if (found === undefined) throw new TypeError(`Missing ${actionId} decision`);
  return found;
}

describe("goal-scoped cancellation semantics", () => {
  it("permits Standard + Scheduled only before processing begins", () => {
    const result = evaluate(facts());

    expect(decision(result, "proc_cancel01")).toMatchObject({
      status: "allowed",
      reasonCodes: ["PERMITTED"],
    });
    expect(result.plan.status).toBe("ready");
    expect(result.plan.steps.at(-1)?.procedureActionId).toBe("proc_cancel01");
  });

  it("never permits an Instant transfer merely because its status is Scheduled", () => {
    const result = evaluate(facts({ "payment.method": "instant", "verification.begun": true }));

    expect(decision(result, "proc_cancel01")).toMatchObject({
      status: "forbidden",
      reasonCodes: ["PROHIBITED"],
    });
  });

  it("keeps cancellation indeterminate when transfer type is unknown", () => {
    const state = facts();
    delete state["payment.method"];
    const result = evaluate(state);

    expect(decision(result, "proc_cancel01")).toMatchObject({
      status: "indeterminate",
      missingFacts: ["payment.method"],
      reasonCodes: ["MISSING_FACTS"],
    });
    expect(result.plan.status).toBe("needs_information");
  });

  it("blocks cancellation once the transfer is Processing", () => {
    const result = evaluate(facts({
      "payment.status": "processing",
      "transfer.processingBegun": true,
    }));

    expect(decision(result, "proc_cancel01")).toMatchObject({
      status: "forbidden",
      reasonCodes: ["NOT_PERMITTED"],
    });
    expect(result.plan.status).toBe("blocked");
  });

  it("selects recovery for a Completed transfer only when eligibility is known true", () => {
    const result = evaluate(facts({
      "payment.status": "completed",
      "transfer.processingBegun": true,
      "recovery.eligible": true,
    }));

    expect(decision(result, "proc_cancel01").status).toBe("forbidden");
    expect(decision(result, "proc_recover1").status).toBe("allowed");
    expect(result.plan.status).toBe("ready");
    expect(result.plan.steps.at(-1)?.procedureActionId).toBe("proc_recover1");
  });

  it("requests information for Completed transfers with unknown recovery eligibility", () => {
    const state = facts({
      "payment.status": "completed",
      "transfer.processingBegun": true,
    });
    delete state["recovery.eligible"];
    const result = evaluate(state);

    expect(decision(result, "proc_recover1")).toMatchObject({
      status: "indeterminate",
      missingFacts: ["recovery.eligible"],
    });
    expect(result.plan.status).toBe("needs_information");
  });

  it("preserves all permission qualifiers and stable action references", () => {
    const model = goalScopedModel();
    const cancelRule = model.rules.find((rule) => rule.id === "rule_cancelpermit1");
    const actionIds = new Set(model.actions.map((action) => action.id));

    expect(cancelRule?.appliesWhen).toMatchObject({ kind: "all" });
    if (cancelRule?.appliesWhen.kind !== "all") return;
    expect(cancelRule.appliesWhen.conditions).toHaveLength(3);
    expect(model.goalActionIds.every((id) => actionIds.has(id))).toBe(true);
    expect(model.actions.every((action) =>
      action.prerequisiteActionIds.every((id) => actionIds.has(id)),
    )).toBe(true);
    expect(model.rules.every((rule) => actionIds.has(rule.actionId))).toBe(true);
  });

  it("fails closed when focused permission evidence does not match", () => {
    const model = goalScopedModel();
    const mismatched = ProcedureModelSchema.parse({
      ...model,
      id: "procedure_goalmismatch1",
      rules: model.rules.map((rule) =>
        rule.id === "rule_cancelpermit1"
          ? {
              ...rule,
              citations: rule.citations.map((citation) => ({
                ...citation,
                excerpt: "Transfers can always be canceled.",
              })),
            }
          : rule,
      ),
    });
    const validation = validateEvidence(baseSnapshotFixture, mismatched, {
      evidenceResultId: "evidence_mismatch01",
      checkedAt: "2026-10-17T12:00:00.000Z",
    });
    if (!validation.ok) throw new TypeError(validation.issues.join("; "));
    const state = UserStateSchema.parse({ schemaVersion: 1, revision: 1, facts: facts() });
    const result = evaluatePolicies(mismatched, validation.evidence, state);
    const cancel = result.decisions.find((candidate) => candidate.actionId === "proc_cancel01");

    expect(validation.evidence.rejectedRuleIds).toContain("rule_cancelpermit1");
    expect(cancel).toMatchObject({
      status: "review",
      reasonCodes: expect.arrayContaining(["EVIDENCE_REJECTED"]),
    });
  });
});
