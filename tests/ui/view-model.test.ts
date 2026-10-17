import { describe, expect, it } from "vitest";

import { FixtureDemoProvider } from "../../src/ui/adapters/fixtureDemoProvider.js";
import {
  demoGoal,
  demoSnapshot,
  scheduledInstantState,
  scheduledStandardState,
} from "../../src/ui/fixtures/demoArtifacts.js";
import {
  decisionTone,
  evidenceCards,
  excludedActions,
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
    expect(rejectedRuleCards.every((card) => card.status === "rejected")).toBe(
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
    });
  });
});
