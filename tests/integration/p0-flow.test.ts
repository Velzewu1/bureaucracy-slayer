import { describe, expect, it } from "vitest";

import { UserStateSchema } from "../../src/contracts/index.js";
import { evaluatePolicies } from "../../src/engine/index.js";
import {
  baseProcedureModelFixture,
  completedStateFixture,
  conflictingEvidenceModelFixture,
  scheduledInstantStateFixture,
  scheduledStandardStateFixture,
  wrongQuoteModelFixture,
} from "../fixtures/p0.js";
import { runPlan, validatedArtifacts } from "../helpers.js";

describe("P0 fixture-driven flows", () => {
  it("Experiment 1: blocks the cancellation conflict and selects the evidenced support alternative", () => {
    const { model, evidence } = validatedArtifacts(baseProcedureModelFixture);
    const state = UserStateSchema.parse(scheduledInstantStateFixture);
    const evaluation = evaluatePolicies(model, evidence, state);
    const cancel = evaluation.decisions.find((decision) => decision.actionId === "proc_cancel01");
    const plan = runPlan(baseProcedureModelFixture, scheduledInstantStateFixture);

    expect(cancel).toMatchObject({ status: "review", reasonCodes: expect.arrayContaining(["POLICY_CONFLICT"]) });
    expect(plan.status).toBe("ready");
    expect(plan.steps.map((step) => step.procedureActionId)).toEqual(["proc_support1"]);
    expect(plan.warnings.some((warning) => warning.includes("proc_cancel01"))).toBe(true);
  });

  it("Experiment 2: changes route from cancellation to recovery without changing the model", () => {
    const initial = runPlan(baseProcedureModelFixture, scheduledStandardStateFixture);
    const replanned = runPlan(baseProcedureModelFixture, completedStateFixture);

    expect(initial.procedureModelId).toBe(replanned.procedureModelId);
    expect(initial.evidenceResultId).toBe(replanned.evidenceResultId);
    expect(initial.steps.at(-1)?.procedureActionId).toBe("proc_cancel01");
    expect(replanned.steps.at(-1)?.procedureActionId).toBe("proc_recover1");
    expect(initial.userStateHash).not.toBe(replanned.userStateHash);
  });

  it("Experiment 3A: stops when critical permit evidence has a trust failure", () => {
    const plan = runPlan(wrongQuoteModelFixture, scheduledStandardStateFixture);
    expect(plan.status).toBe("review_required");
    expect(plan.steps).toEqual([]);
    expect(plan.reasonCodes).toContain("EVIDENCE_REJECTED");
  });

  it("Experiment 3B: requires review for directly contradictory policy evidence", () => {
    const plan = runPlan(conflictingEvidenceModelFixture, scheduledInstantStateFixture);
    expect(plan.status).toBe("review_required");
    expect(plan.steps).toEqual([]);
    expect(plan.reasonCodes).toContain("POLICY_CONFLICT");
  });
});

