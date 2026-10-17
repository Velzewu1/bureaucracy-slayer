import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UserStateSchema, type ProcedureModel } from "../../src/contracts/index.js";
import { FixtureDemoProvider } from "../../src/ui/adapters/fixtureDemoProvider.js";
import {
  RecordedExtractionProvider,
  recordedExtractionBundle,
} from "../../src/ui/adapters/recordedExtractionProvider.js";
import { GuidedPersonalization } from "../../src/ui/components/GuidedPersonalization.js";
import { UserStatePanel } from "../../src/ui/components/UserStatePanel.js";
import {
  demoGoal,
  demoProcedureModel,
  demoSnapshot,
  scheduledInstantState,
  scheduledStandardState,
  unknownMethodState,
} from "../../src/ui/fixtures/demoArtifacts.js";
import {
  factOptions,
  guidedDecisionPresentation,
  selectGuidedQuestion,
} from "../../src/ui/guidedPersonalization.js";
import type { DemoAnalysis } from "../../src/ui/types.js";
import { updateUserFact } from "../../src/ui/viewModel.js";

const fixedNow = () => "2026-10-17T04:00:00.000Z";

function provider(): FixtureDemoProvider {
  return new FixtureDemoProvider({ now: fixedNow });
}

async function analyzeUnknown(): Promise<DemoAnalysis> {
  return provider().analyze({
    goal: demoGoal,
    portalUrl: demoSnapshot.rootUrl,
    scenarioId: "unknown-fact",
    userState: unknownMethodState,
  });
}

describe("guided personalization", () => {
  it("uses the existing adaptive ranking and canonical fact label and choices", async () => {
    const analysis = await analyzeUnknown();
    const selected = selectGuidedQuestion(analysis);

    expect(selected).toMatchObject({
      source: "adaptive",
      definition: { key: "payment.method", label: "Transfer method" },
      adaptiveQuestion: { distinctOutcomeCount: 2 },
    });

    const markup = renderToStaticMarkup(
      createElement(GuidedPersonalization, {
        analysis,
        userState: analysis.userState,
        isBusy: false,
        onAnswer: () => {},
      }),
    );
    expect(markup).toContain("Transfer method");
    expect(markup).toContain("standard");
    expect(markup).toContain("instant");
    expect(markup).toContain("I&#x27;m not sure");
    expect(markup).toContain("Why we&#x27;re asking");
    expect(markup).toContain("Policy sources related to this question");
  });

  it("falls back deterministically to canonical model order without claiming optimization", async () => {
    const analysis = await analyzeUnknown();
    const facts = { ...analysis.userState.facts };
    delete facts["payment.status"];
    const { nextQuestion: _nextQuestion, ...intelligence } = analysis.decisionIntelligence;
    const withoutRankedQuestions: DemoAnalysis = {
      ...analysis,
      userState: { ...analysis.userState, facts },
      plan: {
        ...analysis.plan,
        missingFacts: ["payment.method", "payment.status"],
      },
      decisionIntelligence: { ...intelligence, questions: [] },
    };

    const selected = selectGuidedQuestion(withoutRankedQuestions);

    expect(selected).toMatchObject({
      source: "canonical_fallback",
      definition: { key: "payment.status" },
    });
  });

  it("keeps unknown absent and limits boolean and enum answers to declared domains", () => {
    const method = demoProcedureModel.factDefinitions.find(
      (definition) => definition.key === "payment.method",
    );
    const verification = demoProcedureModel.factDefinitions.find(
      (definition) => definition.key === "verification.complete",
    );
    if (method === undefined || verification === undefined) {
      throw new Error("Expected fixture facts are missing");
    }

    expect(factOptions(method)).toEqual(["standard", "instant"]);
    expect(factOptions(verification)).toEqual([true, false]);

    const unknown = updateUserFact(scheduledStandardState, "payment.method", undefined);
    expect(unknown.facts).not.toHaveProperty("payment.method");
    expect(unknown.facts["payment.method"]).toBeUndefined();
  });

  it("renders Guided and All facts from the same canonical user state", async () => {
    const sessionProvider = provider();
    const original = await sessionProvider.analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: scheduledStandardState,
    });
    const changedState = UserStateSchema.parse({
      schemaVersion: 1,
      revision: original.userState.revision + 1,
      facts: { ...original.userState.facts, "payment.method": "instant" },
    });
    const updated = await sessionProvider.replan(original.sessionId, changedState);

    const guided = renderToStaticMarkup(
      createElement(GuidedPersonalization, {
        analysis: updated,
        userState: updated.userState,
        isBusy: false,
        onAnswer: () => {},
      }),
    );
    const allFacts = renderToStaticMarkup(
      createElement(UserStatePanel, {
        model: updated.model,
        userState: updated.userState,
        missingFacts: updated.plan.missingFacts,
        isDirty: false,
        isBusy: false,
        onFactChange: () => {},
        onReplan: () => {},
      }),
    );

    expect(guided).toContain("instant");
    expect(allFacts).toContain('<option value="instant" selected="">instant</option>');
    expect(updated.snapshot.id).toBe(original.snapshot.id);
    expect(updated.evidence.id).toBe(original.evidence.id);
    expect(updated.source.extractionPreviouslyCompleted).toBe(
      original.source.extractionPreviouslyCompleted,
    );
  });

  it("supports changing an earlier answer through local replanning", async () => {
    const sessionProvider = provider();
    const original = await sessionProvider.analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: scheduledStandardState,
    });
    const instant = UserStateSchema.parse({
      schemaVersion: 1,
      revision: original.plan.userStateRevision + 1,
      facts: scheduledInstantState.facts,
    });
    const updated = await sessionProvider.replan(original.sessionId, instant);

    expect(updated.userState.facts["payment.method"]).toBe("instant");
    expect(updated.plan.steps.map((step) => step.procedureActionId)).toEqual([
      "proc_support1",
    ]);
    expect(updated.snapshot.id).toBe(original.snapshot.id);
    expect(updated.model.id).toBe(original.model.id);
    expect(updated.evidence.id).toBe(original.evidence.id);
  });

  it("does not present unrelated definitions as necessary", async () => {
    const analysis = await analyzeUnknown();
    const unrelated: ProcedureModel["factDefinitions"][number] = {
      key: "profile.newsletter",
      label: "Newsletter preference",
      type: "boolean",
      sensitive: false,
    };
    const extended: DemoAnalysis = {
      ...analysis,
      model: {
        ...analysis.model,
        factDefinitions: [unrelated, ...analysis.model.factDefinitions],
      },
    };

    expect(selectGuidedQuestion(extended)?.definition.key).toBe("payment.method");
  });

  it("maps engine outcomes to compact truthful feedback without clearing review gates", async () => {
    const fixture = provider();
    const ready = await fixture.analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: scheduledStandardState,
    });
    const needsInformation = await analyzeUnknown();
    const review = await new RecordedExtractionProvider({ now: fixedNow }).analyze({
      goal: recordedExtractionBundle.extractionGoal,
      portalUrl: recordedExtractionBundle.sourceSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: scheduledStandardState,
    });

    expect(guidedDecisionPresentation(ready).label).toBe(
      "Ready to proceed with verified guidance",
    );
    expect(guidedDecisionPresentation(needsInformation).label).toBe(
      "More information needed",
    );
    expect(guidedDecisionPresentation(review).label).toBe("Requires review");

    const answered = await new RecordedExtractionProvider({ now: fixedNow }).analyze({
      goal: recordedExtractionBundle.extractionGoal,
      portalUrl: recordedExtractionBundle.sourceSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: scheduledInstantState,
    });
    expect(answered.plan.status).toBe("review_required");
    expect(guidedDecisionPresentation(answered).label).toBe("Requires review");
  });
});
