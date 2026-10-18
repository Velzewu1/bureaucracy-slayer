import { describe, expect, it } from "vitest";

import { FixtureDemoProvider } from "../../src/ui/adapters/fixtureDemoProvider.js";
import {
  demoGoal,
  demoProcedureModel,
  demoSnapshot,
  scheduledInstantState,
  scheduledStandardState,
} from "../../src/ui/fixtures/demoArtifacts.js";
import {
  actionReadinessPresentation,
  decisionTone,
  evidenceCards,
  excludedActions,
  formatFactInfluence,
  isDecisiveRule,
  planDifference,
  routeSteps,
  updateUserFact,
} from "../../src/ui/viewModel.js";

function provider(): FixtureDemoProvider {
  return new FixtureDemoProvider({
    now: () => "2026-10-17T04:00:00.000Z",
  });
}

describe("UI view models", () => {
  it("keeps canonical plan step order and exposes policy excerpts and sources", async () => {
    const analysis = await provider().analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: scheduledStandardState,
    });

    const steps = routeSteps(analysis);

    expect(steps.map((step) => step.index)).toEqual([1, 2]);
    expect(steps[0]?.citations[0]?.excerpt).toBe(
      "Open the transfer details and choose Cancel transfer to cancel an eligible transfer.",
    );
    expect(steps[1]?.citations[0]?.pageUrl).toBe(
      "https://northstar.test/help/transfers",
    );
  });

  it("makes forbidden and review decisions visually distinguishable", async () => {
    const analysis = await provider().analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "policy-exception",
      userState: scheduledInstantState,
    });
    const excluded = excludedActions(analysis);
    const cancel = excluded.find((action) => action.id === "proc_cancel01");
    const recovery = excluded.find((action) => action.id === "proc_recover1");

    expect(cancel?.status).toBe("forbidden");
    expect(cancel?.reasonCodes).toContain("PROHIBITED");
    expect(recovery?.status).toBe("forbidden");
    expect(decisionTone("forbidden")).toBe("danger");
  });

  it("never presents rejected evidence as verified", async () => {
    const analysis = await provider().analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "evidence-failure",
      userState: scheduledStandardState,
    });
    const rejectedRuleCards = evidenceCards(analysis).filter(
      (card) => card.ruleId === "rule_cancelpermit1",
    );

    expect(rejectedRuleCards).not.toHaveLength(0);
    expect(rejectedRuleCards.every((card) => card.status === "citation_mismatch")).toBe(
      true,
    );
    expect(
      rejectedRuleCards.every((card) => card.issueCodes.includes("EXCERPT_MISMATCH")),
    ).toBe(true);
  });

  it("updates and removes user facts without embedding policy decisions", () => {
    const changed = updateUserFact(
      scheduledStandardState,
      "payment.method",
      "instant",
    );
    const removed = updateUserFact(changed, "payment.method", undefined);

    expect(changed.facts["payment.method"]).toBe("instant");
    expect(removed.facts).not.toHaveProperty("payment.method");
    expect(removed.revision).toBe(scheduledStandardState.revision);
  });

  it("summarizes a deterministic route change and immutable evidence bindings", async () => {
    const demoProvider = provider();
    const original = await demoProvider.analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: scheduledStandardState,
    });
    const updated = await demoProvider.replan(original.sessionId, {
      ...scheduledInstantState,
      revision: original.plan.userStateRevision + 1,
    });

    expect(planDifference(original, updated)).toMatchObject({
      changed: true,
      removedActions: ["Open transfer details", "Cancel transfer"],
      addedActions: ["Contact support"],
      changedFacts: [
        {
          key: "payment.method",
          label: "Transfer method",
          before: "standard",
          after: "instant",
        },
      ],
      snapshotUnchanged: true,
      evidenceUnchanged: true,
      routeChanged: true,
    });
  });

  it("does not call a new plan id a route change when ready stays ready", async () => {
    const demoProvider = provider();
    const original = await demoProvider.analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: scheduledStandardState,
    });
    const updated = await demoProvider.replan(original.sessionId, {
      ...scheduledStandardState,
      revision: original.plan.userStateRevision + 1,
    });

    expect(original.plan.id).not.toBe(updated.plan.id);
    expect(original.plan.status).toBe("ready");
    expect(updated.plan.status).toBe("ready");
    expect(planDifference(original, updated)).toMatchObject({
      changed: false,
      routeChanged: false,
      stepsChanged: false,
      statusChanged: false,
      factsChanged: false,
      outcomeUnchanged: true,
    });
    expect(planDifference(original, updated).unchangedExplanation).toContain(
      "did not change",
    );
  });

  it("reports a fact change without calling an unchanged review a new route", async () => {
    const demoProvider = provider();
    const original = await demoProvider.analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "evidence-failure",
      userState: scheduledStandardState,
    });
    const updated = await demoProvider.replan(original.sessionId, {
      ...scheduledStandardState,
      revision: original.plan.userStateRevision + 1,
      facts: {
        ...scheduledStandardState.facts,
        "verification.complete": false,
      },
    });

    const difference = planDifference(original, updated);
    expect(original.plan.status).toBe("review_required");
    expect(updated.plan.status).toBe("review_required");
    expect(difference).toMatchObject({
      changed: false,
      routeChanged: false,
      factsChanged: true,
      stepsChanged: false,
      outcomeUnchanged: true,
    });
    expect(difference.unchangedExplanation).toContain("Human review required");
    expect(difference.unchangedExplanation).toContain("did not change");
  });

  it("names the required value separately from the user's answer", () => {
    expect(
      formatFactInfluence(demoProcedureModel, {
        key: "payment.status",
        operator: "eq",
        expected: "completed",
        known: true,
        actual: "scheduled",
        truth: "false",
      }),
    ).toBe(
      "Transfer status — Required: completed · Your answer: scheduled · Condition not met",
    );
    expect(
      formatFactInfluence(demoProcedureModel, {
        key: "payment.status",
        operator: "eq",
        expected: "instant",
        known: true,
        actual: "instant",
        truth: "true",
      }),
    ).toContain("Condition met");
  });

  it("keeps matched prohibitions visible and collapses inactive rules", () => {
    expect(
      isDecisiveRule({
        applicability: "matched",
        evidenceState: "verified",
        semanticReviewRequired: false,
      }),
    ).toBe(true);
    expect(
      isDecisiveRule({
        applicability: "not_matched",
        evidenceState: "verified",
        semanticReviewRequired: false,
      }),
    ).toBe(false);
    expect(
      isDecisiveRule({
        applicability: "not_matched",
        evidenceState: "rejected",
        semanticReviewRequired: true,
      }),
    ).toBe(true);
    expect(actionReadinessPresentation("forbidden", ["NOT_PERMITTED"]).label).not.toBe(
      actionReadinessPresentation("forbidden", ["PROHIBITED"]).label,
    );
  });
});
