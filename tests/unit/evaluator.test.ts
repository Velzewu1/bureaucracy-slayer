import { describe, expect, it } from "vitest";

import { UserStateSchema, hashCanonical } from "../../src/contracts/index.js";
import { evaluatePolicies, planActions } from "../../src/engine/index.js";
import { recordedSonnetBundleInput } from "../../src/ui/generated/recordedSonnetBundle.js";
import { RecordedExtractionBundleSchema } from "../../src/ui/recordedBundle.js";
import {
  baseProcedureModelFixture,
  conflictingEvidenceModelFixture,
  plannerContextFixture,
  scheduledInstantStateFixture,
  scheduledStandardStateFixture,
  semanticReviewModelFixture,
  unknownMethodStateFixture,
  wrongQuoteModelFixture,
} from "../fixtures/p0.js";
import { validatedArtifacts } from "../helpers.js";

const recordedBundle = RecordedExtractionBundleSchema.parse(recordedSonnetBundleInput);

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

  it("does not authorize an action when its prohibition is omitted from the evidence partition", () => {
    const { model, evidence } = validatedArtifacts(baseProcedureModelFixture);
    const state = UserStateSchema.parse(scheduledInstantStateFixture);
    const incompleteEvidence = {
      ...evidence,
      validRuleIds: evidence.validRuleIds.filter((ruleId) => ruleId !== "rule_instantdeny1"),
      rejectedRuleIds: evidence.rejectedRuleIds.filter((ruleId) => ruleId !== "rule_instantdeny1"),
    };
    const result = evaluatePolicies(model, incompleteEvidence, state);
    const decision = result.decisions.find((candidate) => candidate.actionId === "proc_cancel01");

    expect(decision).toMatchObject({
      status: "review",
      reasonCodes: expect.arrayContaining(["EVIDENCE_REJECTED"]),
    });
  });

  it("keeps a verified active prohibition dominant when the permit evidence is rejected", () => {
    const decision = decisionFor(wrongQuoteModelFixture, scheduledInstantStateFixture, "proc_cancel01");

    expect(decision).toMatchObject({
      status: "forbidden",
      reasonCodes: expect.arrayContaining(["EVIDENCE_REJECTED", "PROHIBITED"]),
      citationRuleIds: expect.arrayContaining(["rule_instantdeny1"]),
    });
  });

  it("keeps a verified active prohibition dominant when the permit is indeterminate", () => {
    const state = structuredClone(scheduledInstantStateFixture);
    const facts: Record<string, string | boolean> = { ...state.facts };
    delete facts["payment.status"];

    const decision = decisionFor(
      baseProcedureModelFixture,
      { ...state, facts },
      "proc_cancel01",
    );

    expect(decision).toMatchObject({
      status: "forbidden",
      reasonCodes: ["PROHIBITED"],
      missingFacts: expect.arrayContaining(["payment.status"]),
    });
  });

  it("is invariant to policy rule ordering when permits and prohibitions conflict", () => {
    const permit = baseProcedureModelFixture.rules.find((rule) => rule.id === "rule_cancelpermit1");
    const prohibition = baseProcedureModelFixture.rules.find((rule) => rule.id === "rule_instantdeny1");
    if (permit === undefined || prohibition === undefined) throw new Error("Missing conflict rules");
    const rules = [
      ...baseProcedureModelFixture.rules,
      { ...permit, id: "rule_cancelpermit2" },
      { ...prohibition, id: "rule_instantdeny2" },
    ];
    const forwardModel = {
      ...baseProcedureModelFixture,
      rules,
    };
    const reversedModel = {
      ...baseProcedureModelFixture,
      rules: [...rules].reverse(),
    };
    expect(decisionFor(reversedModel, scheduledInstantStateFixture, "proc_cancel01")).toEqual(
      decisionFor(forwardModel, scheduledInstantStateFixture, "proc_cancel01"),
    );
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

  it("does not treat a rejected prohibition as a verified prohibition", () => {
    const rejectedProhibitionModel = {
      ...baseProcedureModelFixture,
      id: "procedure_badprohibition1",
      rules: baseProcedureModelFixture.rules.map((rule) =>
        rule.id === "rule_instantdeny1"
          ? {
              ...rule,
              citations: rule.citations.map((citation) => ({
                ...citation,
                excerpt: "Instant transfers are always cancellable.",
              })),
            }
          : rule,
      ),
    };

    const decision = decisionFor(rejectedProhibitionModel, scheduledInstantStateFixture, "proc_cancel01");

    expect(decision).toMatchObject({
      status: "review",
      reasonCodes: expect.arrayContaining(["EVIDENCE_REJECTED"]),
    });
    expect(decision.reasonCodes).not.toContain("PROHIBITED");
  });

  it("keeps recorded Completed cancellation forbidden despite its rejected permit", () => {
    const state = UserStateSchema.parse({
      ...recordedBundle.defaultScenario.userState,
      revision: 2,
      facts: {
        ...recordedBundle.defaultScenario.userState.facts,
        transfer_status: "completed",
        processing_started: false,
      },
    });
    const result = evaluatePolicies(recordedBundle.procedureModel, recordedBundle.buildTimeEvidence, state);
    const decision = result.decisions.find((candidate) => candidate.actionId === "proc_cancel_transfer");

    expect(decision).toMatchObject({
      status: "forbidden",
      reasonCodes: expect.arrayContaining(["EVIDENCE_REJECTED", "PROHIBITED"]),
      citationRuleIds: expect.arrayContaining(["rule_r1_prohibit_cancel_completed"]),
    });
  });

  it("keeps recorded Scheduled Standard cancellation under review when its permit is rejected", () => {
    const result = evaluatePolicies(
      recordedBundle.procedureModel,
      recordedBundle.buildTimeEvidence,
      recordedBundle.defaultScenario.userState,
    );
    const decision = result.decisions.find((candidate) => candidate.actionId === "proc_cancel_transfer");

    expect(decision).toMatchObject({
      status: "review",
      reasonCodes: expect.arrayContaining(["EVIDENCE_REJECTED"]),
    });
    expect(decision?.reasonCodes).not.toContain("PROHIBITED");
  });

  it("never plans cancellation steps for forbidden or review outcomes", () => {
    const cancelOnlyModel = {
      ...wrongQuoteModelFixture,
      id: "procedure_cancelonly1",
      goalActionIds: ["proc_cancel01"],
    };
    const { model, evidence } = validatedArtifacts(cancelOnlyModel);

    for (const [stateInput, expectedStatus] of [
      [scheduledInstantStateFixture, "blocked"],
      [scheduledStandardStateFixture, "review_required"],
    ] as const) {
      const state = UserStateSchema.parse(stateInput);
      const evaluation = evaluatePolicies(model, evidence, state);
      const plan = planActions(model, evidence, evaluation, state, {
        ...plannerContextFixture,
        userStateHash: hashCanonical(state),
      });

      expect(plan.status).toBe(expectedStatus);
      expect(plan.steps).toEqual([]);
    }
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

  it("marks evidence with a stale snapshot binding before producing action decisions", () => {
    const { model, evidence } = validatedArtifacts(baseProcedureModelFixture);
    const state = UserStateSchema.parse(scheduledStandardStateFixture);
    const result = evaluatePolicies(model, { ...evidence, snapshotHash: "differenthash0001" }, state);

    expect(result.status).toBe("stale");
    expect(result.decisions).toEqual([]);
    expect(result.reasonCodes).toContain("SNAPSHOT_EVIDENCE_MISMATCH");
  });
});

