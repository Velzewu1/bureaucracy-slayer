import { describe, expect, it } from "vitest";

import { UserStateSchema } from "../../src/contracts/index.js";
import { FixtureDemoProvider } from "../../src/ui/adapters/fixtureDemoProvider.js";
import {
  RecordedExtractionProvider,
  recordedExtractionBundle,
} from "../../src/ui/adapters/recordedExtractionProvider.js";
import {
  demoGoal,
  demoSnapshot,
  scheduledInstantState,
  scheduledStandardState,
} from "../../src/ui/fixtures/demoArtifacts.js";
import {
  baseProcedureModelFixture,
  scheduledStandardStateFixture,
  semanticReviewModelFixture,
} from "../fixtures/p0.js";
import { runPlan } from "../helpers.js";
import { LIVE_EXTRACTION_E2E_SCENARIOS } from "../e2e/live-extraction-scenarios.js";
import { createLiveArtifactFixture } from "./live-extraction/contract-fixtures.js";

const fixedNow = () => "2026-10-17T12:00:00.000Z";

describe("live extraction pre-merge integration gates", () => {
  it("keeps the Verified Fixture and Recorded Sonnet providers functional offline", async () => {
    const fixture = await new FixtureDemoProvider({ now: fixedNow }).analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: scheduledStandardState,
    });
    const recorded = await new RecordedExtractionProvider({ now: fixedNow }).analyze({
      goal: recordedExtractionBundle.extractionGoal,
      portalUrl: recordedExtractionBundle.sourceSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: recordedExtractionBundle.defaultScenario.userState,
    });

    expect(fixture.plan.status).toBe("ready");
    expect(fixture.plan.steps.every((step) => step.autoExecutable === false)).toBe(true);
    expect(recorded.snapshot.id).toBe(recordedExtractionBundle.identity.snapshotId);
    expect(recorded.source).toMatchObject({
      label: "Recorded Sonnet extraction",
      extractionPreviouslyCompleted: true,
    });
  });

  it("preserves ready, forbidden, completed-alternative, and review-required safety outcomes", async () => {
    const provider = new FixtureDemoProvider({ now: fixedNow });
    const standard = await provider.analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: scheduledStandardState,
    });
    const instant = await provider.analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "policy-exception",
      userState: scheduledInstantState,
    });
    const completed = await provider.analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: UserStateSchema.parse({
        schemaVersion: 1,
        revision: 2,
        facts: {
          "payment.status": "completed",
          "payment.method": "standard",
          "transfer.processingBegun": true,
          "verification.begun": true,
          "verification.complete": true,
        },
      }),
    });
    const ambiguous = runPlan(semanticReviewModelFixture, scheduledStandardStateFixture);

    expect(standard.plan).toMatchObject({ status: "ready" });
    expect(
      instant.evaluation.decisions.find((decision) => decision.actionId === "proc_cancel01"),
    ).toMatchObject({ status: "forbidden" });
    expect(
      completed.evaluation.decisions.find((decision) => decision.actionId === "proc_cancel01"),
    ).toMatchObject({ status: "forbidden" });
    expect(completed.plan.steps.at(-1)?.procedureActionId).toBe("proc_recover1");
    expect(ambiguous).toMatchObject({ status: "review_required", steps: [] });
  });

  it("defines every requested Phase 2 browser scenario with fake data and guidance-only invariants", () => {
    const expectedIds = [
      "verified-fixture-regression",
      "recorded-sonnet-regression",
      "live-start",
      "live-progress",
      "standard-cancellation-ready",
      "instant-cancellation-forbidden",
      "completed-cancellation-forbidden",
      "ambiguous-recovery-review",
      "duplicate-start-idempotency",
      "transport-failure",
      "invalid-evidence-fails-closed",
      "mode-session-isolation",
      "guidance-only",
    ];

    expect(LIVE_EXTRACTION_E2E_SCENARIOS.map((scenario) => scenario.id)).toEqual(expectedIds);
    expect(new Set(expectedIds).size).toBe(expectedIds.length);
    expect(
      LIVE_EXTRACTION_E2E_SCENARIOS.every((scenario) =>
        scenario.paidClaudeCalls === 0 &&
        scenario.guidanceOnly &&
        scenario.given.length > 0 &&
        scenario.assertions.length > 0),
    ).toBe(true);
    expect(createLiveArtifactFixture().evidence.status).toBe("degraded");
  });

  it("keeps every currently executable plan step guidance-only", () => {
    const plans = [
      runPlan(baseProcedureModelFixture, scheduledStandardStateFixture),
      runPlan(semanticReviewModelFixture, scheduledStandardStateFixture),
    ];
    expect(
      plans.flatMap((plan) => plan.steps).every((step) => step.autoExecutable === false),
    ).toBe(true);
  });
});
