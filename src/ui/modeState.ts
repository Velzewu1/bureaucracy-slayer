import type { UserState } from "../contracts/index.js";
import { recordedExtractionBundle } from "./adapters/recordedExtractionProvider.js";
import {
  demoGoal,
  demoScenarios,
  demoSnapshot,
} from "./fixtures/demoArtifacts.js";
import type { DemoAnalysis, DemoMode, DemoScenarioId } from "./types.js";

export type ModeWorkspaceState = Readonly<{
  mode: DemoMode;
  goal: string;
  portalUrl: string;
  scenarioId: DemoScenarioId;
  userState: UserState;
  analysis: DemoAnalysis | null;
  originalAnalysis: DemoAnalysis | null;
  isDirty: boolean;
  error: string | null;
}>;

function fixtureDefaultState(): UserState {
  const scenario = demoScenarios.find((candidate) => candidate.id === "dynamic-replanning");
  if (scenario === undefined) throw new Error("Default fixture scenario is unavailable.");
  return scenario.defaultUserState;
}

function copyUserState(userState: UserState): UserState {
  return {
    schemaVersion: 1,
    revision: userState.revision,
    facts: { ...userState.facts },
  };
}

export function createModeWorkspaceState(mode: DemoMode): ModeWorkspaceState {
  const recorded = mode === "recorded_sonnet";
  return {
    mode,
    goal: recorded ? recordedExtractionBundle.extractionGoal : demoGoal,
    portalUrl: recorded ? recordedExtractionBundle.sourceSnapshot.rootUrl : demoSnapshot.rootUrl,
    scenarioId: "dynamic-replanning",
    userState: copyUserState(
      recorded
        ? recordedExtractionBundle.defaultScenario.userState
        : fixtureDefaultState(),
    ),
    analysis: null,
    originalAnalysis: null,
    isDirty: false,
    error: null,
  };
}
