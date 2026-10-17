import { describe, expect, it } from "vitest";

import { UserStateSchema, hashCanonical, type ProcedureModel } from "../../src/contracts/index.js";
import { evaluatePolicies, planActions } from "../../src/engine/index.js";
import {
  baseProcedureModelFixture,
  completedStateFixture,
  plannerContextFixture,
  scheduledStandardStateFixture,
  unknownMethodStateFixture,
  wrongQuoteModelFixture,
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

  it("blocks a goal whose active policy-required action is forbidden", () => {
    const requirementRule = {
      id: "rule_supportreq1",
      actionId: "proc_cancel01",
      effect: "require_action",
      appliesWhen: { kind: "always" },
      requiredActionId: "proc_support1",
      citations: [
        {
          pageId: "page_policy001",
          pageUrl: "https://northstar.test/help/transfers",
          blockId: "block_support01",
          excerpt: "If a transfer cannot be canceled, contact support for available options.",
          actionIds: [],
        },
      ],
      semanticConfidence: 0.9,
      needsReview: false,
    } as const;
    const model = {
      ...baseProcedureModelFixture,
      id: "procedure_required1",
      goalActionIds: ["proc_cancel01"],
      rules: [...baseProcedureModelFixture.rules, requirementRule],
    };

    const plan = runPlan(model, scheduledStandardStateFixture);
    expect(plan.status).toBe("blocked");
    expect(plan.reasonCodes).toContain("NOT_PERMITTED");
    expect(plan.steps).toEqual([]);
  });

  it("keeps an unrelated valid alternative ready when another route has rejected evidence", () => {
    const plan = runPlan(wrongQuoteModelFixture, {
      ...scheduledStandardStateFixture,
      facts: {
        ...scheduledStandardStateFixture.facts,
        "payment.method": "instant",
        "verification.begun": true,
      },
    });

    expect(plan.status).toBe("ready");
    expect(plan.steps.map((step) => step.procedureActionId)).toEqual(["proc_support1"]);
    expect(plan.warnings.some((warning) => warning.includes("proc_cancel01") && warning.includes("EVIDENCE_REJECTED"))).toBe(true);
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

  it("does not describe a blocked route with positive reasons from allowed prerequisites", () => {
    const plan = runPlan(baseProcedureModelFixture, scheduledStandardStateFixture);
    const recoveryWarning = plan.warnings.find((warning) => warning.includes("proc_recover1"));

    expect(recoveryWarning).toBe("Route proc_recover1 was blocked: NOT_PERMITTED");
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

  it("rejects a caller-supplied user-state hash that does not bind the supplied state", () => {
    const { model, evidence } = validatedArtifacts(baseProcedureModelFixture);
    const state = UserStateSchema.parse(scheduledStandardStateFixture);
    const evaluation = evaluatePolicies(model, evidence, state);
    const plan = planActions(model, evidence, evaluation, state, {
      ...plannerContextFixture,
      userStateHash: "differentuserstatehash0001",
    });

    expect(plan.status).toBe("stale");
    expect(plan.reasonCodes).toContain("USER_STATE_HASH_MISMATCH");
  });
});

