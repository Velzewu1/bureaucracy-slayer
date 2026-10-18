import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FixtureDemoProvider } from "../../src/ui/adapters/fixtureDemoProvider.js";
import { recordedExtractionBundle } from "../../src/ui/adapters/recordedExtractionProvider.js";
import {
  App,
  livePersonalizationState,
} from "../../src/ui/App.js";
import { LIVE_DEMO_GOAL } from "../../src/ui/adapters/liveExtractionProvider.js";
import {
  LiveProgressPanel,
  liveProgressTitle,
  liveStageState,
} from "../../src/ui/components/LiveProgressPanel.js";
import { PersonalizationPlaceholder } from "../../src/ui/components/PersonalizationPlaceholder.js";
import { SafeRoutePanel } from "../../src/ui/components/SafeRoutePanel.js";
import { UserStatePanel } from "../../src/ui/components/UserStatePanel.js";
import {
  demoGoal,
  demoSnapshot,
  scheduledStandardState,
} from "../../src/ui/fixtures/demoArtifacts.js";
import {
  applyAnalysisResult,
  beginModeAnalysis,
  createModeWorkspaceState,
  failModeAnalysis,
} from "../../src/ui/modeState.js";
import type {
  DemoDataProvider,
  LiveResumeState,
} from "../../src/ui/types.js";

function resumableProvider(resumeState: LiveResumeState): DemoDataProvider {
  return {
    analyze: async () => {
      throw new Error("Not used during static rendering");
    },
    replan: async () => {
      throw new Error("Not used during static rendering");
    },
    getEvidence: async () => {
      throw new Error("Not used during static rendering");
    },
    resumeState: () => resumeState,
  };
}

describe("Live personalization UX", () => {
  it("presents the server-owned goal as locked context rather than a disabled form field", () => {
    const markup = renderToStaticMarkup(
      createElement(App, { initialMode: "live_sonnet" }),
    );

    expect(markup).toContain('data-testid="locked-goal"');
    expect(markup).toContain("Locked demo goal");
    expect(markup).toContain(LIVE_DEMO_GOAL);
    expect(markup).toContain(
      "The goal and fictional portal are server-owned for this bounded demonstration.",
    );
    expect(markup).not.toContain('id="user-goal"');
    expect(markup).not.toContain("<textarea");
  });

  it("shows an empty situation state before analysis, with no fake controls", () => {
    const markup = renderToStaticMarkup(
      createElement(App, { initialMode: "live_sonnet" }),
    );

    expect(markup).toContain("Your situation");
    expect(markup).toContain("relevant questions once the website");
    expect(markup).toContain("Start by analyzing the website.");
    expect(markup).not.toContain('class="personalization-placeholder"');
    expect(markup).not.toContain("<select");
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("payment.status");
    expect(markup.match(/>Analyze Website<\/button>/gu)?.length).toBe(1);
  });

  it("shows a stable identifying state while Live extraction is loading", () => {
    const markup = renderToStaticMarkup(
      createElement(PersonalizationPlaceholder, { state: "identifying" }),
    );

    expect(livePersonalizationState("analyzing", null, false)).toBe(
      "identifying",
    );
    expect(markup).toContain("Relevant questions will appear here when verification finishes.");
    expect(markup).toContain("This step does not ask for facts yet.");
    expect(markup).not.toContain('class="personalization-placeholder"');
    expect(markup).not.toContain("<select");
    expect(markup).not.toContain("<input");
  });

  it("renders canonical fact controls only after verified analysis", async () => {
    const analysis = await new FixtureDemoProvider().analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: scheduledStandardState,
    });
    const markup = renderToStaticMarkup(
      createElement(UserStatePanel, {
        model: analysis.model,
        userState: analysis.userState,
        missingFacts: analysis.plan.missingFacts,
        isDirty: false,
        isBusy: false,
        onFactChange: () => {},
        onReplan: () => {},
      }),
    );

    expect(markup).toContain("Your facts");
    expect(markup).toContain("payment.status");
    expect(markup).toContain("Replan with updated facts");
    expect(markup).not.toContain('aria-disabled="true"');
  });

  it("clears prior Live facts and guidance before a new run and after failure", async () => {
    const fixture = await new FixtureDemoProvider().analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: scheduledStandardState,
    });
    const completed = applyAnalysisResult(
      createModeWorkspaceState("live_sonnet"),
      "live_sonnet",
      { ...fixture, mode: "live_sonnet" },
      "analysis",
    );

    const loading = beginModeAnalysis(completed);
    const failed = failModeAnalysis(
      completed,
      "live_sonnet",
      "The controlled portal is unavailable.",
      "live_operational",
    );

    expect(loading.analysis).toBeNull();
    expect(loading.userState.facts).toEqual({});
    expect(failed.analysis).toBeNull();
    expect(failed.originalAnalysis).toBeNull();
    expect(failed.userState.facts).toEqual({});
    expect(livePersonalizationState(null, failed.errorKind, false)).toBe(
      "unavailable",
    );
    const markup = renderToStaticMarkup(
      createElement(PersonalizationPlaceholder, { state: "unavailable" }),
    );
    expect(markup).toContain("This run did not produce verified questions");
    expect(markup).toContain("Use the header action to try again.");
    expect(markup).not.toContain("<select");
    expect(markup).not.toContain("payment.status");
  });

  it("keeps recovery waiting without exposing facts after a refresh", () => {
    const markup = renderToStaticMarkup(
      createElement(App, {
        initialMode: "live_sonnet",
        providers: { live_sonnet: resumableProvider("job") },
      }),
    );

    expect(markup).toContain("Resume analysis");
    expect(markup).toContain("Start by analyzing the website.");
    expect(markup).not.toContain("payment.status");
    expect(markup).not.toContain("<select");
  });

  it("locks personalization before verification for every retained provider seam", () => {
    const fixtureMarkup = renderToStaticMarkup(
      createElement(App, { initialMode: "verified_fixture" }),
    );
    const recordedMarkup = renderToStaticMarkup(
      createElement(App, { initialMode: "recorded_sonnet" }),
    );

    for (const markup of [fixtureMarkup, recordedMarkup]) {
      expect(markup).toContain("Start by analyzing the website.");
      expect(markup).not.toContain("Replan with updated facts");
    }
    const firstRecordedFact =
      recordedExtractionBundle.procedureModel.factDefinitions[0];
    if (firstRecordedFact === undefined) {
      throw new Error("Recorded fixture must declare at least one fact.");
    }
    expect(recordedMarkup).not.toContain(firstRecordedFact.key);
  });
});

describe("Live progress and decision hierarchy", () => {
  it("maps backend phases to the five user-facing stages without premature completion", () => {
    expect(liveProgressTitle("mapping_procedure")).toBe(
      "Extracting policies and procedures…",
    );
    expect(
      liveStageState("selecting_sources", {
        label: "Collecting website evidence",
        firstPhase: "collecting",
      }),
    ).toBe("complete");
    expect(
      liveStageState("selecting_sources", {
        label: "Selecting relevant source material",
        firstPhase: "selecting_sources",
      }),
    ).toBe("current");
    expect(
      liveStageState("selecting_sources", {
        label: "Extracting policies and procedures",
        firstPhase: "extracting_policy",
      }),
    ).toBe("pending");

    const markup = renderToStaticMarkup(
      createElement(LiveProgressPanel, {
        phase: "validating",
        onStop: () => {},
      }),
    );
    expect(markup).toContain("Collecting website evidence");
    expect(markup).toContain("Selecting relevant source material");
    expect(markup).toContain("Extracting policies and procedures");
    expect(markup).toContain("Validating evidence");
    expect(markup).toContain("Preparing the decision");
    expect(markup).not.toMatch(/\d+%|minutes? remaining/i);
  });

  it("labels the main decision, verified steps, and required information distinctly", async () => {
    const analysis = await new FixtureDemoProvider().analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: scheduledStandardState,
    });
    const markup = renderToStaticMarkup(
      createElement(SafeRoutePanel, { analysis }),
    );

    expect(markup).toContain("Decision status");
    expect(markup).toContain("Verified next steps");
    expect(markup).toContain("Verified guidance");
  });
});
