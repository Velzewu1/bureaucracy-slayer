import { describe, expect, it } from "vitest";

import { UserStateSchema } from "../../src/contracts/index.js";
import { FixtureDemoProvider } from "../../src/ui/adapters/fixtureDemoProvider.js";
import {
  demoGoal,
  demoSnapshot,
  scheduledInstantState,
  scheduledStandardState,
} from "../../src/ui/fixtures/demoArtifacts.js";

const fixedNow = () => "2026-10-17T04:00:00.000Z";

function createProvider(): FixtureDemoProvider {
  return new FixtureDemoProvider({ now: fixedNow });
}

describe("FixtureDemoProvider", () => {
  it("runs the recorded artifacts through the real engine and preserves canonical step order", async () => {
    const provider = createProvider();
    const analysis = await provider.analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: scheduledStandardState,
    });

    expect(analysis.plan.status).toBe("ready");
    expect(analysis.plan.steps.map((step) => step.index)).toEqual([1, 2]);
    expect(analysis.plan.steps.map((step) => step.procedureActionId)).toEqual([
      "proc_open001",
      "proc_cancel01",
    ]);
    expect(analysis.plan.steps.every((step) => step.autoExecutable === false)).toBe(true);
  });

  it("replans from changed UserState without changing snapshot or evidence bindings", async () => {
    const provider = createProvider();
    const original = await provider.analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: scheduledStandardState,
    });
    const changedState = UserStateSchema.parse({
      ...scheduledInstantState,
      revision: original.plan.userStateRevision + 1,
    });

    const updated = await provider.replan(original.sessionId, changedState);

    expect(updated.plan.id).not.toBe(original.plan.id);
    expect(updated.plan.steps.map((step) => step.procedureActionId)).toEqual([
      "proc_support1",
    ]);
    expect(updated.snapshot.id).toBe(original.snapshot.id);
    expect(updated.model.id).toBe(original.model.id);
    expect(updated.evidence.id).toBe(original.evidence.id);
    expect(updated.replanMode).toBe("deterministic_engine");
  });

  it("returns needs_information when a potentially restrictive rule depends on an unknown fact", async () => {
    const provider = createProvider();
    const incompleteState = UserStateSchema.parse({
      schemaVersion: 1,
      revision: 1,
      facts: {
        "payment.status": "scheduled",
        "transfer.processingBegun": false,
        "verification.begun": true,
        "verification.complete": true,
      },
    });

    const analysis = await provider.analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: incompleteState,
    });

    expect(analysis.plan.status).toBe("needs_information");
    expect(analysis.plan.missingFacts).toContain("payment.method");
    expect(analysis.plan.steps).toEqual([]);
  });

  it("prohibits an Instant scheduled transfer even when the Cancel control is visible", async () => {
    const provider = createProvider();
    const analysis = await provider.analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "policy-exception",
      userState: scheduledInstantState,
    });
    const cancel = analysis.evaluation.decisions.find(
      (decision) => decision.actionId === "proc_cancel01",
    );
    const cancelControl = analysis.snapshot.pages
      .flatMap((page) => page.actions)
      .find((action) => action.id === "action_cancel01");

    expect(cancelControl).toMatchObject({ visible: true, enabled: true });
    expect(cancel).toMatchObject({ status: "forbidden", reasonCodes: ["PROHIBITED"] });
    expect(analysis.plan.steps.map((step) => step.procedureActionId)).toEqual(["proc_support1"]);
  });

  it("fails closed when the recorded permit citation does not match its source block", async () => {
    const provider = createProvider();
    const analysis = await provider.analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "evidence-failure",
      userState: scheduledStandardState,
    });

    expect(analysis.evidence.status).toBe("degraded");
    expect(analysis.evidence.rejectedRuleIds).toContain("rule_cancelpermit1");
    expect(analysis.evidence.issues.map((issue) => issue.code)).toContain(
      "EXCERPT_MISMATCH",
    );
    expect(analysis.plan.status).toBe("review_required");
    expect(analysis.plan.steps).toEqual([]);
  });

  it("exposes the canonical evidence result for a valid session", async () => {
    const provider = createProvider();
    const analysis = await provider.analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "policy-exception",
      userState: scheduledInstantState,
    });

    await expect(provider.getEvidence(analysis.sessionId)).resolves.toEqual(
      analysis.evidence,
    );
  });

  it("reports safe errors for unsupported fixture requests and missing sessions", async () => {
    const provider = createProvider();

    await expect(
      provider.analyze({
        goal: "",
        portalUrl: demoSnapshot.rootUrl,
        scenarioId: "dynamic-replanning",
        userState: scheduledStandardState,
      }),
    ).rejects.toThrow("Enter a goal");
    await expect(
      provider.replan("session_missing01", scheduledStandardState),
    ).rejects.toThrow("no longer available");
  });
});
