import type { UserState } from "../contracts/index.js";
import {
  LIVE_DEMO_GOAL,
  LIVE_DEMO_PORTAL_URL,
} from "./adapters/liveExtractionProvider.js";
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
  errorKind:
    | "analysis"
    | "replan"
    | "live_operational"
    | "live_integrity"
    | "live_stopped"
    | null;
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

export function createModeWorkspaceState(
  mode: DemoMode,
  recoveredLiveGoal?: string,
): ModeWorkspaceState {
  const recorded = mode === "recorded_sonnet";
  const live = mode === "live_sonnet";
  return {
    mode,
    goal: live
      ? recoveredLiveGoal ?? LIVE_DEMO_GOAL
      : recorded
        ? recordedExtractionBundle.extractionGoal
        : demoGoal,
    portalUrl: live
      ? LIVE_DEMO_PORTAL_URL
      : recorded
        ? recordedExtractionBundle.sourceSnapshot.rootUrl
        : demoSnapshot.rootUrl,
    scenarioId: "dynamic-replanning",
    userState: live
      ? { schemaVersion: 1, revision: 0, facts: {} }
      : copyUserState(
          recorded
            ? recordedExtractionBundle.defaultScenario.userState
            : fixtureDefaultState(),
        ),
    analysis: null,
    originalAnalysis: null,
    isDirty: false,
    error: null,
    errorKind: null,
  };
}

export function changeLiveGoal(
  current: ModeWorkspaceState,
  goal: string,
): ModeWorkspaceState {
  if (current.mode !== "live_sonnet" || current.goal === goal) return current;
  return {
    ...current,
    goal,
    analysis: null,
    originalAnalysis: null,
    userState: { schemaVersion: 1, revision: 0, facts: {} },
    isDirty: false,
    error: null,
    errorKind: null,
  };
}

export function applyAnalysisResult(
  current: ModeWorkspaceState,
  expectedMode: DemoMode,
  analysis: DemoAnalysis,
  kind: "analysis" | "replan",
): ModeWorkspaceState {
  if (current.mode !== expectedMode || analysis.mode !== expectedMode) return current;
  return {
    ...current,
    goal: analysis.goal,
    analysis,
    originalAnalysis: kind === "analysis" ? analysis : current.originalAnalysis,
    userState: analysis.userState,
    isDirty: false,
    error: null,
    errorKind: null,
  };
}

export function beginModeAnalysis(current: ModeWorkspaceState): ModeWorkspaceState {
  return {
    ...current,
    ...(current.mode === "live_sonnet"
      ? {
          analysis: null,
          originalAnalysis: null,
          userState: { schemaVersion: 1, revision: 0, facts: {} },
          isDirty: false,
        }
      : {}),
    error: null,
    errorKind: null,
  };
}

export function failModeAnalysis(
  current: ModeWorkspaceState,
  expectedMode: DemoMode,
  message: string,
  errorKind: Exclude<ModeWorkspaceState["errorKind"], null> = "analysis",
): ModeWorkspaceState {
  if (current.mode !== expectedMode) return current;
  return {
    ...current,
    ...(current.mode === "live_sonnet"
      ? {
          analysis: null,
          originalAnalysis: null,
          userState: { schemaVersion: 1, revision: 0, facts: {} },
          isDirty: false,
        }
      : {}),
    error: message,
    errorKind,
  };
}

export function failModeReplan(
  current: ModeWorkspaceState,
  expectedMode: DemoMode,
  message: string,
): ModeWorkspaceState {
  if (current.mode !== expectedMode) return current;
  const analysis = current.analysis;
  return {
    ...current,
    ...(analysis === null
      ? {}
      : {
          userState: copyUserState(analysis.userState),
          isDirty: false,
        }),
    error: message,
    errorKind: "replan",
  };
}

export function stopLiveModeForNavigation(
  current: ModeWorkspaceState,
): ModeWorkspaceState {
  if (current.mode !== "live_sonnet") return current;
  const analysis = current.analysis;
  return {
    ...current,
    ...(analysis === null
      ? { analysis: null, originalAnalysis: null, isDirty: false }
      : {
          userState: copyUserState(analysis.userState),
          isDirty: false,
        }),
    error:
      "Live browser activity stopped for navigation. Backend extraction, if running, was not cancelled.",
    errorKind: "live_stopped",
  };
}
