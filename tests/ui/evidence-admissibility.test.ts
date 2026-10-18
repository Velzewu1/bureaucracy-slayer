import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FixtureDemoProvider } from "../../src/ui/adapters/fixtureDemoProvider.js";
import {
  RecordedExtractionProvider,
  recordedExtractionBundle,
} from "../../src/ui/adapters/recordedExtractionProvider.js";
import { DecisionIntelligencePanel } from "../../src/ui/components/DecisionIntelligencePanel.js";
import { PolicyEvidencePanel } from "../../src/ui/components/PolicyEvidencePanel.js";
import {
  demoGoal,
  demoSnapshot,
  scheduledInstantState,
  scheduledStandardState,
  unknownMethodState,
} from "../../src/ui/fixtures/demoArtifacts.js";
import {
  actionReadinessPresentation,
  policyRulePresentations,
} from "../../src/ui/viewModel.js";

const fixedNow = () => "2026-10-17T12:00:00.000Z";

function fixtureProvider(): FixtureDemoProvider {
  return new FixtureDemoProvider({ now: fixedNow });
}

describe("evidence admissibility UI", () => {
  it("shows a matched rejected permit as separate condition and evidence states, never Active", async () => {
    const analysis = await fixtureProvider().analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "evidence-failure",
      userState: scheduledStandardState,
    });
    const permit = policyRulePresentations(analysis).find(
      (rule) => rule.ruleId === "rule_cancelpermit1",
    );
    const markup = renderToStaticMarkup(
      createElement(DecisionIntelligencePanel, { analysis }),
    );

    expect(permit).toMatchObject({
      effect: "permit",
      applicability: "matched",
      conditionLabel: "Condition matched",
      evidenceState: "rejected",
      evidenceLabel: "Evidence rejected",
    });
    expect(permit?.rejectionReasons).toContain(
      "Citation excerpt does not exactly match block block_general01.",
    );
    expect(markup).toContain("PERMIT · Condition matched · Evidence rejected");
    expect(markup).not.toMatch(/>\s*Active\s*</i);
  });

  it("uses authoritative readiness labels for each action-decision state", () => {
    expect(actionReadinessPresentation("allowed").label).toBe("Action ready");
    expect(actionReadinessPresentation("forbidden").label).toBe("Not authorized");
    expect(actionReadinessPresentation("forbidden", ["PROHIBITED"]).label).toBe(
      "Action prohibited",
    );
    expect(actionReadinessPresentation("forbidden", ["NOT_PERMITTED"]).label).toBe(
      "No verified permission",
    );
    expect(actionReadinessPresentation("forbidden", ["REQUIREMENT_FAILED"]).label).toBe(
      "Required condition not met",
    );
    expect(actionReadinessPresentation("review", ["EVIDENCE_REJECTED"]).label).toBe(
      "Evidence needs review",
    );
    expect(actionReadinessPresentation("review").label).toBe("Human review required");
    expect(actionReadinessPresentation("indeterminate").label).toBe(
      "More information required",
    );
  });

  it("presents semantic review separately from citation mismatch", async () => {
    const analysis = await new RecordedExtractionProvider({ now: fixedNow }).analyze({
      goal: recordedExtractionBundle.extractionGoal,
      portalUrl: recordedExtractionBundle.sourceSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: recordedExtractionBundle.defaultScenario.userState,
    });
    const reviewed = policyRulePresentations(analysis).filter(
      (rule) => rule.semanticReviewRequired,
    );
    const markup = renderToStaticMarkup(
      createElement(PolicyEvidencePanel, { analysis }),
    );

    expect(reviewed).not.toHaveLength(0);
    expect(reviewed.every((rule) => rule.evidenceState === "rejected")).toBe(true);
    expect(markup).toContain("Semantic review required");
    expect(markup).not.toContain("Citation mismatch");
  });

  it("keeps a verified prohibition visually and semantically distinct", async () => {
    const analysis = await fixtureProvider().analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "policy-exception",
      userState: scheduledInstantState,
    });
    const prohibition = policyRulePresentations(analysis).find(
      (rule) => rule.ruleId === "rule_instantdeny1",
    );
    const markup = renderToStaticMarkup(
      createElement(PolicyEvidencePanel, { analysis }),
    );

    expect(prohibition).toMatchObject({
      effect: "prohibit",
      applicability: "matched",
      evidenceState: "verified",
      evidenceLabel: "Evidence verified",
    });
    expect(markup).toContain("PROHIBIT · Condition matched · Evidence verified");
    expect(markup).toContain("evidence-card--effect-prohibit");
  });

  it("distinguishes an unresolved condition from rejected evidence", async () => {
    const analysis = await fixtureProvider().analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "unknown-fact",
      userState: unknownMethodState,
    });
    const unresolved = policyRulePresentations(analysis).find(
      (rule) => rule.applicability === "unresolved",
    );

    expect(unresolved).toMatchObject({
      conditionLabel: "Condition unresolved",
      evidenceState: "verified",
      evidenceLabel: "Evidence verified",
    });
  });

  it("keeps the current action decision authoritative over matched rule conditions", async () => {
    const analysis = await fixtureProvider().analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "evidence-failure",
      userState: scheduledStandardState,
    });
    const actionState = actionReadinessPresentation(
      analysis.decisionIntelligence.trace.decision.status,
    );
    const markup = renderToStaticMarkup(
      createElement(DecisionIntelligencePanel, { analysis }),
    );

    expect(actionState.label).toBe("Human review required");
    expect(markup).toContain('data-testid="authoritative-action-state"');
    expect(markup).toContain("Human review required");
    expect(markup).not.toContain("Action ready");
  });

  it("preserves counterfactual outcomes while stating that evidence gates do not change", async () => {
    const analysis = await fixtureProvider().analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: scheduledStandardState,
    });
    const before = structuredClone(analysis.decisionIntelligence.counterfactuals);
    const markup = renderToStaticMarkup(
      createElement(DecisionIntelligencePanel, { analysis }),
    );

    expect(analysis.decisionIntelligence.counterfactuals).toEqual(before);
    expect(markup).toContain("Evidence admissibility is unchanged");
  });

  it("keeps citations available and collapses rules that do not decide the result", async () => {
    const analysis = await new RecordedExtractionProvider({ now: fixedNow }).analyze({
      goal: recordedExtractionBundle.extractionGoal,
      portalUrl: recordedExtractionBundle.sourceSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: recordedExtractionBundle.defaultScenario.userState,
    });
    const markup = renderToStaticMarkup(
      createElement(DecisionIntelligencePanel, { analysis }),
    );

    expect(markup).toContain("View policy evidence");
    expect(markup).toContain("Required:");
    expect(markup).toContain("Your answer:");
    expect(markup).toContain("cannot repair that evidence limitation");
    expect(markup).toContain('data-testid="nondecisive-rules"');
    expect(markup).not.toContain("→ false");
    expect(markup).not.toContain("→ true");
  });
});
