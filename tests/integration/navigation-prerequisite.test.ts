import { describe, expect, it } from "vitest";

import { ProcedureModelSchema, UserStateSchema } from "../../src/contracts/index.js";
import { evaluatePolicies } from "../../src/engine/index.js";
import {
  baseProcedureModelFixture,
  scheduledInstantStateFixture,
  scheduledStandardStateFixture,
} from "../fixtures/p0.js";
import { runPlan, validatedArtifacts } from "../helpers.js";

function withoutOpenPermit() {
  return ProcedureModelSchema.parse({
    ...structuredClone(baseProcedureModelFixture),
    rules: baseProcedureModelFixture.rules.filter((rule) => rule.id !== "rule_openpermit1"),
  });
}

function withoutArtificialNavigation() {
  const source = structuredClone(baseProcedureModelFixture);
  return ProcedureModelSchema.parse({
    ...source,
    actions: source.actions
      .filter((action) => action.id !== "proc_open001")
      .map((action) => ({
        ...action,
        prerequisiteActionIds: action.prerequisiteActionIds.filter(
          (prerequisiteId) => prerequisiteId !== "proc_open001",
        ),
      })),
    rules: source.rules.filter((rule) => rule.id !== "rule_openpermit1"),
  });
}

describe("navigation and policy prerequisite separation", () => {
  it("keeps an unsupported navigation prerequisite blocked", () => {
    const model = withoutOpenPermit();
    const { evidence } = validatedArtifacts(model);
    const state = UserStateSchema.parse(scheduledStandardStateFixture);
    const evaluation = evaluatePolicies(model, evidence, state);

    expect(evaluation.decisions.find((decision) => decision.actionId === "proc_open001"))
      .toMatchObject({ status: "forbidden", reasonCodes: ["NOT_PERMITTED"] });
    expect(runPlan(model, state)).toMatchObject({
      status: "blocked",
      reasonCodes: ["NOT_PERMITTED"],
      steps: [],
    });
  });

  it("permits cancellation without an artificial navigation dependency", () => {
    const model = withoutArtificialNavigation();
    const plan = runPlan(model, scheduledStandardStateFixture);

    expect(plan.status).toBe("ready");
    expect(plan.steps.map((step) => step.procedureActionId)).toEqual(["proc_cancel01"]);
    expect(plan.steps.every((step) => step.autoExecutable === false)).toBe(true);
  });

  it("preserves genuine governed prerequisites and prohibition dominance", () => {
    const standardPlan = runPlan(baseProcedureModelFixture, scheduledStandardStateFixture);
    expect(standardPlan.steps.map((step) => step.procedureActionId)).toEqual([
      "proc_open001",
      "proc_cancel01",
    ]);
    expect(standardPlan.steps.every((step) => step.autoExecutable === false)).toBe(true);

    const { model, evidence } = validatedArtifacts(baseProcedureModelFixture);
    const instantState = UserStateSchema.parse(scheduledInstantStateFixture);
    const evaluation = evaluatePolicies(model, evidence, instantState);
    expect(evaluation.decisions.find((decision) => decision.actionId === "proc_cancel01"))
      .toMatchObject({ status: "review", reasonCodes: expect.arrayContaining(["POLICY_CONFLICT"]) });
  });
});
