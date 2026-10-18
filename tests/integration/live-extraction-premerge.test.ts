import { describe, expect, it } from "vitest";

import { UserStateSchema } from "../../src/contracts/index.js";
import { FixtureDemoProvider } from "../../src/ui/adapters/fixtureDemoProvider.js";
import { LiveExtractionProvider } from "../../src/ui/adapters/liveExtractionProvider.js";
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
import {
  createGoalSpecificLiveArtifactFixture,
  createLiveArtifactFixture,
  LIVE_TEST_CANCELLATION_GOAL,
  LIVE_TEST_RECOVERY_GOAL,
  LIVE_TEST_RECOVERY_PREREQUISITES_GOAL,
} from "./live-extraction/contract-fixtures.js";
import { startLiveMockApi } from "./live-extraction/mock-api.js";

const fixedNow = () => "2026-10-17T12:00:00.000Z";

describe("live extraction pre-merge integration gates", () => {
  it("rejects reuse of one request ID for a different normalized goal", async () => {
    const api = await startLiveMockApi({ goalAware: true });
    const requestId = "request_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const post = (goal: string) => fetch(`${api.origin}/api/live-extraction/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 2,
        action: "start_live_extraction",
        requestId,
        goal,
      }),
    });
    try {
      expect((await post(LIVE_TEST_CANCELLATION_GOAL)).status).toBe(202);
      const mismatch = await post(LIVE_TEST_RECOVERY_GOAL);
      expect(mismatch.status).toBe(409);
      await expect(mismatch.json()).resolves.toMatchObject({
        error: { code: "REQUEST_IDENTITY_MISMATCH" },
      });
      expect(api.physicalJobStarts).toBe(1);
      expect(api.submittedGoals).toEqual([LIVE_TEST_CANCELLATION_GOAL]);
    } finally {
      await api.close();
    }
  });

  it("keeps three offline goals isolated and fails an unsupported goal closed", async () => {
    const api = await startLiveMockApi({ goalAware: true });
    const requestIds = [1, 2, 3, 4].map(
      (value) => `request_${value.toString(16).padStart(32, "0")}` as const,
    );
    const provider = new LiveExtractionProvider({
      expectedSource: "offline_mock",
      fetch: (input, init) => {
        const raw = typeof input === "string" ? input : input.toString();
        return fetch(new URL(raw, api.origin), init);
      },
      generateRequestId: () => {
        const next = requestIds.shift();
        if (next === undefined) throw new Error("Unexpected mock request ID allocation.");
        return next;
      },
      wait: async () => {},
    });
    const goals = [
      LIVE_TEST_CANCELLATION_GOAL,
      LIVE_TEST_RECOVERY_GOAL,
      LIVE_TEST_RECOVERY_PREREQUISITES_GOAL,
    ] as const;

    try {
      const analyses = [];
      for (const goal of goals) {
        const analysis = await provider.analyze({
          goal,
          portalUrl: "http://127.0.0.1:5180/dashboard",
          scenarioId: "dynamic-replanning",
          userState: { schemaVersion: 1, revision: 0, facts: {} },
        });
        analyses.push(analysis);
        expect(analysis.goal).toBe(goal);
        expect(analysis.source).toMatchObject({
          kind: "offline_mock_replay",
          modelName: "deterministic-offline-test-fixture",
        });
        expect(analysis.plan.steps.every((step) => step.autoExecutable === false)).toBe(true);
        const invalidRules = new Set(analysis.evidence.rejectedRuleIds);
        expect(
          analysis.evaluation.decisions.every((decision) =>
            decision.status !== "allowed" ||
            decision.citationRuleIds.every((ruleId) => !invalidRules.has(ruleId)),
          ),
        ).toBe(true);
      }

      expect(new Set(analyses.map((analysis) => analysis.model.id)).size).toBe(3);
      expect(analyses[0]?.model.factDefinitions.map((fact) => fact.key))
        .not.toEqual(analyses[1]?.model.factDefinitions.map((fact) => fact.key));
      const fetchCount = api.requests.length;
      const first = analyses[0];
      if (first === undefined) throw new Error("Missing cancellation analysis.");
      await expect(provider.replan(first.sessionId, first.userState))
        .rejects.toMatchObject({ code: "SESSION_MISSING" });
      expect(api.requests).toHaveLength(fetchCount);

      await expect(provider.analyze({
        goal: "How do I close my mortgage?",
        portalUrl: "http://127.0.0.1:5180/dashboard",
        scenarioId: "dynamic-replanning",
        userState: { schemaVersion: 1, revision: 0, facts: {} },
      })).rejects.toMatchObject({ code: "SOURCE_SELECTION_INCOMPLETE" });
      expect(api.submittedGoals).toEqual([...goals, "How do I close my mortgage?"]);
      expect(api.physicalJobStarts).toBe(4);

      for (const goal of goals) {
        const artifact = createGoalSpecificLiveArtifactFixture(goal);
        expect(artifact?.sourceSelection.coverage).toBe("complete");
        expect(artifact?.sourceSelection.selectedCounts.pages).toBeLessThanOrEqual(9);
        expect(artifact?.sourceSelection.selectedCounts.blocks).toBeLessThanOrEqual(80);
        expect(artifact?.sourceSelection.selectedCounts.actions).toBeLessThanOrEqual(35);
      }
    } finally {
      await api.close();
    }
  });

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
