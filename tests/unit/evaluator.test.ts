import { describe, expect, it } from "vitest";

import { UserStateSchema } from "../../src/contracts/index.js";
import { evaluatePolicies } from "../../src/engine/index.js";
import {
  baseProcedureModelFixture,
  conflictingEvidenceModelFixture,
  scheduledInstantStateFixture,
  scheduledStandardStateFixture,
  semanticReviewModelFixture,
  unknownMethodStateFixture,
  wrongQuoteModelFixture,
} from "../fixtures/p0.js";
import { validatedArtifacts } from "../helpers.js";

function decisionFor(modelInput: unknown, stateInput: unknown, actionId: string) {
  const { model, evidence } = validatedArtifacts(modelInput);
  const state = UserStateSchema.parse(stateInput);
  const result = evaluatePolicies(model, evidence, state);
  const decision = result.decisions.find((candidate) => candidate.actionId === actionId);
  if (decision === undefined) throw new Error(`Missing decision for ${actionId}`);
  return decision;
}

describe("policy evaluation", () => {
  it("allows an action with positive valid evidence and satisfied requirements", () => {
    expect(decisionFor(baseProcedureModelFixture, scheduledStandardStateFixture, "proc_cancel01")).toMatchObject({
      status: "allowed",
      reasonCodes: ["PERMITTED"],
    });
  });

  it("never lets confidence or a permit override an active prohibition", () => {
    const decision = decisionFor(baseProcedureModelFixture, scheduledInstantStateFixture, "proc_cancel01");
    expect(decision.status).toBe("review");
    expect(decision.reasonCodes).toEqual(expect.arrayContaining(["POLICY_CONFLICT", "PROHIBITED"]));
  });

  it("reports directly conflicting evidence for review", () => {
    const decision = decisionFor(conflictingEvidenceModelFixture, scheduledInstantStateFixture, "proc_cancel01");
    expect(decision.status).toBe("review");
    expect(decision.reasonCodes).toContain("POLICY_CONFLICT");
  });

  it("returns indeterminate when a potentially active prohibition needs a missing fact", () => {
    const decision = decisionFor(baseProcedureModelFixture, unknownMethodStateFixture, "proc_cancel01");
    expect(decision.status).toBe("indeterminate");
    expect(decision.missingFacts).toContain("payment.method");
  });

  it("does not turn missing or invalid evidence into permission", () => {
    const decision = decisionFor(wrongQuoteModelFixture, scheduledStandardStateFixture, "proc_cancel01");
    expect(decision.status).toBe("review");
    expect(decision.reasonCodes).toContain("EVIDENCE_REJECTED");
  });

  it("treats semantic insufficiency as review even when the quotation matches", () => {
    const decision = decisionFor(semanticReviewModelFixture, scheduledStandardStateFixture, "proc_cancel01");
    expect(decision.status).toBe("review");
  });

  it("blocks a false mandatory requirement", () => {
    const state = {
      ...scheduledStandardStateFixture,
      facts: { ...scheduledStandardStateFixture.facts, "verification.complete": false },
    };
    expect(decisionFor(baseProcedureModelFixture, state, "proc_cancel01")).toMatchObject({
      status: "forbidden",
      reasonCodes: expect.arrayContaining(["REQUIREMENT_FAILED"]),
    });
  });
});

