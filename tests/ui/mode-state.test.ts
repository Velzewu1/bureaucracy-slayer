import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FixtureDemoProvider } from "../../src/ui/adapters/fixtureDemoProvider.js";
import {
  LIVE_DEMO_GOAL,
  LIVE_DEMO_PORTAL_URL,
} from "../../src/ui/adapters/liveExtractionProvider.js";
import { recordedExtractionBundle } from "../../src/ui/adapters/recordedExtractionProvider.js";
import { ModeSelector } from "../../src/ui/components/ModeSelector.js";
import {
  demoGoal,
  demoSnapshot,
  scheduledStandardState,
} from "../../src/ui/fixtures/demoArtifacts.js";
import {
  applyAnalysisResult,
  createModeWorkspaceState,
} from "../../src/ui/modeState.js";

describe("UI mode state", () => {
  it("creates a clean provider-bound workspace on every mode switch", () => {
    const fixture = createModeWorkspaceState("verified_fixture");
    const dirtyFixture = {
      ...fixture,
      goal: "edited fixture goal",
      isDirty: true,
      error: "old error",
    };
    const recorded = createModeWorkspaceState("recorded_sonnet");

    expect(dirtyFixture.isDirty).toBe(true);
    expect(recorded).toMatchObject({
      mode: "recorded_sonnet",
      goal: recordedExtractionBundle.extractionGoal,
      portalUrl: recordedExtractionBundle.sourceSnapshot.rootUrl,
      analysis: null,
      originalAnalysis: null,
      isDirty: false,
      error: null,
    });
    expect(recorded.userState.facts).toEqual(
      recordedExtractionBundle.defaultScenario.userState.facts,
    );
    expect(recorded.goal).not.toBe(dirtyFixture.goal);

    const fixtureAgain = createModeWorkspaceState("verified_fixture");
    expect(fixtureAgain).toEqual(fixture);
  });

  it("creates Live Sonnet with fixed target identity and no inherited facts or result", () => {
    const live = createModeWorkspaceState("live_sonnet");

    expect(live).toMatchObject({
      mode: "live_sonnet",
      goal: LIVE_DEMO_GOAL,
      portalUrl: LIVE_DEMO_PORTAL_URL,
      userState: { schemaVersion: 1, revision: 0, facts: {} },
      analysis: null,
      originalAnalysis: null,
      isDirty: false,
      error: null,
    });
    expect(live.userState.facts).not.toEqual(
      recordedExtractionBundle.defaultScenario.userState.facts,
    );
  });

  it("suppresses an analysis result after the user has switched to another mode", async () => {
    const analysis = await new FixtureDemoProvider().analyze({
      goal: demoGoal,
      portalUrl: demoSnapshot.rootUrl,
      scenarioId: "dynamic-replanning",
      userState: scheduledStandardState,
    });
    const current = createModeWorkspaceState("recorded_sonnet");

    expect(
      applyAnalysisResult(current, "verified_fixture", analysis, "analysis"),
    ).toBe(current);
  });

  it("renders all three explicit extraction modes", () => {
    const markup = renderToStaticMarkup(
      createElement(ModeSelector, {
        mode: "live_sonnet",
        disabled: false,
        onChange: () => {},
      }),
    );

    expect(markup).toContain("Verified fixture");
    expect(markup).toContain("Recorded Sonnet extraction");
    expect(markup).toContain("Live Sonnet extraction");
    expect(markup).toContain('value="live_sonnet"');
  });
});
