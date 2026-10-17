import { describe, expect, it } from "vitest";

import { recordedExtractionBundle } from "../../src/ui/adapters/recordedExtractionProvider.js";
import { createModeWorkspaceState } from "../../src/ui/modeState.js";

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
});
