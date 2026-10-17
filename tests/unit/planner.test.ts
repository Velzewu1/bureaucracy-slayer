import { describe, expect, it } from "vitest";

import { UserStateSchema, hashCanonical, type ProcedureModel } from "../../src/contracts/index.js";
import { evaluatePolicies, planActions } from "../../src/engine/index.js";
import {
  baseProcedureModelFixture,
  completedStateFixture,
  plannerContextFixture,
  scheduledStandardStateFixture,
  unknownMethodStateFixture,
} from "../fixtures/p0.js";
import { runPlan, validatedArtifacts } from "../helpers.js";

describe("dependency planner", () => {
  it("orders prerequisites before the permitted goal action", () => {
    const plan = runPlan(baseProcedureModelFixture, scheduledStandardStateFixture);
    expect(plan.status).toBe("ready");
    expect(plan.steps.map((step) => step.procedureActionId)).toEqual(["proc_open001", "proc_cancel01"]);
  });

  it("replans to the recovery route using only changed user state", () => {
    const plan = runPlan(baseProcedureModelFixture, completedStateFixture);
    expect(plan.status).toBe("ready");
    expect(plan.steps.map((step) => step.procedureActionId)).toEqual(["proc_open001", "proc_recover1"]);
  });

  it("returns needs_information rather than ready for an unknown prerequisite fact", () => {
    const plan = runPlan(baseProcedureModelFixture, unknownMethodStateFixture);
    expect(plan.status).toBe("needs_information");
    expect(plan.missingFacts).toContain("payment.method");
    expect(plan.steps).toEqual([]);
  });

  it("detects a missing graph prerequisite defensively", () => {
    const { model, evidence } = validatedArtifacts(baseProcedureModelFixture);
    const state = UserStateSchema.parse(scheduledStandardStateFixture);
    const evaluation = evaluatePolicies(model, evidence, state);
    const brokenModel: ProcedureModel = {
      ...model,
      actions: model.actions.map((action) =>
        action.id === "proc_cancel01" ? { ...action, prerequisiteActionIds: ["proc_missing01"] } : action,
      ),
    };
    const plan = planActions(brokenModel, evidence, evaluation, state, {
      ...plannerContextFixture,
      userStateHash: hashCanonical(state),
    });
    expect(plan.status).toBe("review_required");
    expect(plan.reasonCodes).toContain("MISSING_PREREQUISITE");
  });

  it("detects dependency cycles defensively", () => {
    const { model, evidence } = validatedArtifacts(baseProcedureModelFixture);
    const state = UserStateSchema.parse(scheduledStandardStateFixture);
    const evaluation = evaluatePolicies(model, evidence, state);
    const cyclicModel: ProcedureModel = {
      ...model,
      actions: model.actions.map((action) =>
        action.id === "proc_open001" ? { ...action, prerequisiteActionIds: ["proc_cancel01"] } : action,
      ),
    };
    const plan = planActions(cyclicModel, evidence, evaluation, state, {
      ...plannerContextFixture,
      userStateHash: hashCanonical(state),
    });
    expect(plan.status).toBe("review_required");
    expect(plan.reasonCodes).toContain("DEPENDENCY_CYCLE");
  });

  it("is deterministic for identical inputs and injected metadata", () => {
    expect(runPlan(baseProcedureModelFixture, scheduledStandardStateFixture)).toEqual(
      runPlan(baseProcedureModelFixture, scheduledStandardStateFixture),
    );
  });

  it("keeps every recommendation guidance-only", () => {
    const plan = runPlan(baseProcedureModelFixture, scheduledStandardStateFixture);
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps.every((step) => !step.autoExecutable && step.requiresUserConfirmation)).toBe(true);
  });

  it("marks mismatched artifacts stale", () => {
    const { model, evidence } = validatedArtifacts(baseProcedureModelFixture);
    const state = UserStateSchema.parse(scheduledStandardStateFixture);
    const evaluation = evaluatePolicies(model, evidence, state);
    const plan = planActions(model, { ...evidence, snapshotHash: "differenthash0001" }, evaluation, state, {
      ...plannerContextFixture,
      userStateHash: hashCanonical(state),
    });
    expect(plan.status).toBe("stale");
  });
});

