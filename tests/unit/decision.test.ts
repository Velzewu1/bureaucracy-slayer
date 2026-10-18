import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  UserStateSchema,
  hashCanonical,
  type ProcedureModel,
  type UserState,
} from "../../src/contracts/index.js";
import {
  analyzeCounterfactuals,
  analyzeDecisionIntelligence,
  buildDecisionTrace,
  rankAdaptiveQuestions,
  type DecisionInputs,
} from "../../src/decision/index.js";
import { evaluatePolicies, planActions } from "../../src/engine/index.js";
import { createHash as createBrowserHash } from "../../src/ui/shims/nodeCrypto.js";
import {
  baseProcedureModelFixture,
  completedStateFixture,
  scheduledInstantStateFixture,
  scheduledStandardStateFixture,
  unknownMethodStateFixture,
} from "../fixtures/p0.js";
import { validatedArtifacts } from "../helpers.js";

function inputsFor(
  stateInput: unknown,
  modelInput: unknown = baseProcedureModelFixture,
): DecisionInputs {
  const { model, evidence } = validatedArtifacts(modelInput);
  const userState = UserStateSchema.parse(stateInput);
  const evaluation = evaluatePolicies(model, evidence, userState);
  const userStateHash = hashCanonical(userState);
  const plan = planActions(model, evidence, evaluation, userState, {
    planId: `plan_${userStateHash.slice(0, 20)}`,
    generatedAt: "2026-10-17T04:00:00.000Z",
    userStateHash,
  });
  return { model, evidence, evaluation, plan, userState };
}

describe("decision intelligence", () => {
  it("keeps browser-side SHA-256 compatible with canonical hashing", () => {
    expect(createBrowserHash("sha256").update("abc").digest("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("has no Claude, extraction, collector, or Playwright dependency", () => {
    const source = readFileSync(
      new URL("../../src/decision/index.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/anthropic|claude|extractor|extraction|collector|playwright/iu);
  });

  it("traces genuine evaluator results, condition facts, and exact evidence", () => {
    const inputs = inputsFor(scheduledInstantStateFixture);
    const trace = buildDecisionTrace(inputs, "proc_cancel01");
    const permit = trace.rules.find((rule) => rule.ruleId === "rule_cancelpermit1");
    const prohibition = trace.rules.find((rule) => rule.ruleId === "rule_instantdeny1");

    expect(trace.decision.status).toBe("review");
    expect(trace.decision.reasonCodes).toEqual(
      expect.arrayContaining(["POLICY_CONFLICT", "PROHIBITED"]),
    );
    expect(permit?.applicabilityState).toBe("active");
    expect(prohibition?.applicabilityState).toBe("active");
    expect(prohibition?.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "payment.method",
          actual: "instant",
          truth: "true",
        }),
      ]),
    );
    expect(prohibition?.citations[0]?.excerpt).toBe(
      "Instant transfers cannot be canceled after verification has begun.",
    );
  });

  it("finds the standard-to-completed route change through real planning", () => {
    const counterfactual = analyzeCounterfactuals(
      inputsFor(scheduledStandardStateFixture),
      "proc_cancel01",
    ).find(
      (candidate) =>
        candidate.factKey === "payment.status" &&
        candidate.hypotheticalValue === "completed",
    );

    expect(counterfactual).toMatchObject({
      changed: true,
      planStatusAfter: "ready",
      decisionBefore: "allowed",
      decisionAfter: "forbidden",
      routeAfter: ["proc_open001", "proc_recover1"],
    });
  });

  it("ranks a meaningful question for an unknown enumerated fact", () => {
    const questions = rankAdaptiveQuestions(inputsFor(unknownMethodStateFixture));

    expect(questions[0]).toMatchObject({
      factKey: "payment.method",
      distinctOutcomeCount: 2,
    });
    expect(questions[0]?.alternatives.map((alternative) => alternative.value)).toEqual([
      "instant",
      "standard",
    ]);
    expect(questions[0]?.whyItMatters).toContain("distinct evaluated outcomes");
  });

  it("does not mutate UserState while evaluating bounded alternatives", () => {
    const inputs = inputsFor(scheduledStandardStateFixture);
    const before = structuredClone(inputs.userState);
    const intelligence = analyzeDecisionIntelligence(inputs);

    expect(inputs.userState).toEqual(before);
    expect(intelligence.counterfactuals.length).toBeLessThanOrEqual(12);
    expect(
      intelligence.counterfactuals.every(
        (candidate) => candidate.hypotheticalRevision === inputs.userState.revision + 1,
      ),
    ).toBe(true);
  });

  it("does not attribute decisions or questions to unrelated facts", () => {
    const base = validatedArtifacts(baseProcedureModelFixture).model;
    const model: ProcedureModel = {
      ...base,
      factDefinitions: [
        ...base.factDefinitions,
        {
          key: "profile.newsletter",
          label: "Newsletter",
          type: "boolean",
          sensitive: false,
        },
      ],
    };
    const state: UserState = {
      ...UserStateSchema.parse(unknownMethodStateFixture),
      facts: {
        ...UserStateSchema.parse(unknownMethodStateFixture).facts,
        "profile.newsletter": true,
      },
    };
    const intelligence = analyzeDecisionIntelligence(inputsFor(state, model));

    expect(
      intelligence.trace.rules.flatMap((rule) => rule.facts).map((fact) => fact.key),
    ).not.toContain("profile.newsletter");
    expect(intelligence.questions.map((question) => question.factKey)).not.toContain(
      "profile.newsletter",
    );
  });

  it("keeps an active prohibition dominant over an active permission", () => {
    const intelligence = analyzeDecisionIntelligence(inputsFor(scheduledInstantStateFixture));
    const trace = buildDecisionTrace(
      inputsFor(scheduledInstantStateFixture),
      "proc_cancel01",
    );

    expect(trace.decision.status).toBe("review");
    expect(trace.decision.reasonCodes).toContain("PROHIBITED");
    expect(intelligence.trace.actionId).toBe("proc_support1");
  });

  it("does not treat removal of one prohibition as satisfying another requirement", () => {
    const state = UserStateSchema.parse({
      ...scheduledInstantStateFixture,
      facts: {
        ...scheduledInstantStateFixture.facts,
        "verification.complete": false,
      },
    });
    const result = analyzeCounterfactuals(inputsFor(state), "proc_cancel01").find(
      (candidate) =>
        candidate.factKey === "payment.method" &&
        candidate.hypotheticalValue === "standard",
    );

    expect(result).toMatchObject({
      decisionAfter: "forbidden",
      planStatusAfter: "blocked",
    });
    expect(result?.routeAfter).toEqual([]);
  });

  it("is stable for identical inputs and excludes unknown facts from actual state", () => {
    const inputs = inputsFor(completedStateFixture);
    expect(analyzeDecisionIntelligence(inputs)).toEqual(analyzeDecisionIntelligence(inputs));

    const unknownInputs = inputsFor(unknownMethodStateFixture);
    analyzeDecisionIntelligence(unknownInputs);
    expect(unknownInputs.userState.facts).not.toHaveProperty("payment.method");
  });
});
