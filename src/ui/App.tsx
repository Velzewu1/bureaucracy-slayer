import { useEffect, useRef, useState } from "react";

import type { JsonScalar, UserState } from "../contracts/index.js";
import { LiveExtractionGoalSchema } from "../orchestration/live-extraction-contract.js";
import { FixtureDemoProvider } from "./adapters/fixtureDemoProvider.js";
import {
  LiveExtractionClientError,
  LiveExtractionProvider,
} from "./adapters/liveExtractionProvider.js";
import { LiveArtifactIntegrityError } from "./adapters/liveArtifactVerification.js";
import { RecordedExtractionProvider } from "./adapters/recordedExtractionProvider.js";
import { AnalysisSetup } from "./components/AnalysisSetup.js";
import { AppHeader } from "./components/AppHeader.js";
import { DecisionIntelligencePanel } from "./components/DecisionIntelligencePanel.js";
import { ExcludedActionsPanel } from "./components/ExcludedActionsPanel.js";
import { GuidedPersonalization } from "./components/GuidedPersonalization.js";
import { LiveProgressPanel } from "./components/LiveProgressPanel.js";
import { PersonalizationPlaceholder } from "./components/PersonalizationPlaceholder.js";
import type { PersonalizationPlaceholderState } from "./components/PersonalizationPlaceholder.js";
import { PersonalizationViewToggle } from "./components/PersonalizationViewToggle.js";
import { PlanComparison } from "./components/PlanComparison.js";
import { PolicyEvidencePanel } from "./components/PolicyEvidencePanel.js";
import { SafeRoutePanel } from "./components/SafeRoutePanel.js";
import { UserStatePanel } from "./components/UserStatePanel.js";
import type { PersonalizationView } from "./guidedPersonalization.js";
import {
  applyAnalysisResult,
  beginModeAnalysis,
  changeLiveGoal,
  createModeWorkspaceState,
  failModeAnalysis,
  failModeReplan,
  stopLiveModeForNavigation,
} from "./modeState.js";
import {
  UI_EXECUTION_POLICY,
  uiModeForExecutionPolicy,
} from "./runtimeConfig.js";
import type {
  DemoDataProvider,
  DemoMode,
  LiveExtractionPhase,
  LiveResumeState,
} from "./types.js";
import { updateUserFact } from "./viewModel.js";

const fixtureProvider = new FixtureDemoProvider({ latencyMs: 650 });
const recordedProvider = new RecordedExtractionProvider({ latencyMs: 650 });
const liveProvider = new LiveExtractionProvider({
  expectedSource:
    UI_EXECUTION_POLICY === "offline_mock" ? "offline_mock" : "live",
});

type Activity = "analyzing" | "replanning" | null;

export function analysisProgressLabel(_mode: DemoMode, activity: Activity): string {
  return activity === "replanning" ? "Deterministic replan" : "Website analysis";
}

export function deriveLiveRecoveryControls(
  activity: Activity,
  resumeState: LiveResumeState,
): Readonly<{ canResume: boolean; canRetryAmbiguous: boolean }> {
  if (activity !== null) return { canResume: false, canRetryAmbiguous: false };
  return {
    canResume: resumeState === "job",
    canRetryAmbiguous: resumeState === "request",
  };
}

type AppProps = Readonly<{
  /** Provider selection is retained as a non-production seam for provider regression tests. */
  initialMode?: DemoMode;
  provider?: DemoDataProvider;
  providers?: Partial<Readonly<Record<DemoMode, DemoDataProvider>>>;
}>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The analysis could not complete this request.";
}

function liveErrorKind(
  error: unknown,
): "live_operational" | "live_integrity" | "live_stopped" {
  if (error instanceof LiveArtifactIntegrityError) return "live_integrity";
  if (error instanceof LiveExtractionClientError) {
    if (error.code === "CLIENT_STOPPED") return "live_stopped";
    if (
      error.code === "RESPONSE_IDENTITY_MISMATCH" ||
      error.code === "GOAL_MISMATCH" ||
      error.code === "PORTAL_MISMATCH" ||
      error.code === "SOURCE_POLICY_MISMATCH"
    ) {
      return "live_integrity";
    }
  }
  return "live_operational";
}

export function livePersonalizationState(
  activity: Activity,
  errorKind: ReturnType<typeof liveErrorKind> | "analysis" | "replan" | null,
  recoveryBlocked: boolean,
): PersonalizationPlaceholderState {
  if (activity === "analyzing") return "identifying";
  if (
    recoveryBlocked ||
    errorKind === "live_operational" ||
    errorKind === "live_integrity"
  ) {
    return "unavailable";
  }
  return "waiting";
}

function defaultProvider(mode: DemoMode): DemoDataProvider {
  switch (mode) {
    case "verified_fixture":
      return fixtureProvider;
    case "recorded_sonnet":
      return recordedProvider;
    case "live_sonnet":
      return liveProvider;
  }
}

function configuredProvenance(mode: DemoMode): Readonly<{
  label: string;
  detail: string;
}> {
  if (mode === "verified_fixture") {
    return {
      label: "Verified fixture",
      detail: "Hand-checked evidence replay. No browser collection or model call occurs.",
    };
  }
  if (mode === "recorded_sonnet") {
    return {
      label: "Recorded Sonnet replay",
      detail: "Previously generated evidence is revalidated locally. It is not a fresh extraction.",
    };
  }
  return UI_EXECUTION_POLICY === "offline_mock"
    ? {
        label: "Offline mock configured",
        detail:
          "The UI accepts only responses marked by the deterministic mock API. No Anthropic call is made.",
      }
    : {
        label: "Live website analysis",
        detail:
          "Analyze Website starts the server-owned collector and extraction pipeline for the controlled portal.",
      };
}

export function App({
  initialMode = uiModeForExecutionPolicy(UI_EXECUTION_POLICY),
  provider,
  providers,
}: AppProps) {
  const initialProvider = providers?.[initialMode] ?? provider ?? defaultProvider(initialMode);
  const [workspace, setWorkspace] = useState(() =>
    createModeWorkspaceState(initialMode, initialProvider.recoveryGoal?.()),
  );
  const [activity, setActivity] = useState<Activity>(null);
  const [liveProgress, setLiveProgress] = useState<LiveExtractionPhase | null>(null);
  const [personalizationView, setPersonalizationView] =
    useState<PersonalizationView>("guided");
  const runIdRef = useRef(0);
  const busyRef = useRef(false);
  const navigationInterruptedRef = useRef(false);
  const isBusy = activity !== null;
  const activeProvider = providers?.[workspace.mode] ?? provider ?? defaultProvider(workspace.mode);
  const activeProviderRef = useRef<DemoDataProvider>(activeProvider);
  const activeModeRef = useRef(workspace.mode);
  activeProviderRef.current = activeProvider;
  activeModeRef.current = workspace.mode;

  const liveResumeState =
    workspace.mode === "live_sonnet"
      ? activeProvider.resumeState?.() ??
        (activeProvider.canResume?.() === true ? "job" : "none")
      : "none";
  const { canResume: canResumeLive, canRetryAmbiguous: canRetryAmbiguousLive } =
    deriveLiveRecoveryControls(activity, liveResumeState);
  const isLiveRecoveryBlocked =
    workspace.mode === "live_sonnet" && liveResumeState === "blocked";
  const missingFacts = workspace.analysis?.plan.missingFacts ?? [];
  const configured = configuredProvenance(workspace.mode);

  useEffect(() => {
    function stopForNavigation(): void {
      if (activeModeRef.current !== "live_sonnet") return;
      const shouldStop =
        busyRef.current || activeProviderRef.current.canResume?.() === true;
      if (!shouldStop) return;
      navigationInterruptedRef.current = true;
      runIdRef.current += 1;
      busyRef.current = false;
      activeProviderRef.current.stop?.("navigation");
      setActivity(null);
      setLiveProgress(null);
      setWorkspace(stopLiveModeForNavigation);
    }
    function reconcileAfterNavigation(event: PageTransitionEvent): void {
      if (
        !event.persisted ||
        !navigationInterruptedRef.current ||
        activeModeRef.current !== "live_sonnet"
      ) {
        return;
      }
      navigationInterruptedRef.current = false;
      runIdRef.current += 1;
      busyRef.current = false;
      activeProviderRef.current.stop?.("navigation");
      setActivity(null);
      setLiveProgress(null);
      setWorkspace(stopLiveModeForNavigation);
    }
    window.addEventListener("pagehide", stopForNavigation);
    window.addEventListener("pageshow", reconcileAfterNavigation);
    return () => {
      window.removeEventListener("pagehide", stopForNavigation);
      window.removeEventListener("pageshow", reconcileAfterNavigation);
      runIdRef.current += 1;
      busyRef.current = false;
      if (activeModeRef.current === "live_sonnet") {
        activeProviderRef.current.stop?.("component_unmounted");
      }
    };
  }, []);

  function changeFact(key: string, value: JsonScalar | undefined): void {
    setWorkspace((current) => ({
      ...current,
      userState: updateUserFact(current.userState, key, value),
      isDirty: current.analysis !== null,
    }));
  }

  async function analyze(): Promise<void> {
    if (busyRef.current) return;
    const goalResult =
      workspace.mode === "live_sonnet"
        ? LiveExtractionGoalSchema.safeParse(workspace.goal)
        : { success: true as const, data: workspace.goal };
    if (!goalResult.success) {
      setWorkspace((current) => ({
        ...current,
        error: "Enter a non-empty goal without control characters within the configured size limit.",
        errorKind: "analysis",
      }));
      return;
    }
    const startedGoal = goalResult.data;
    busyRef.current = true;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const startedMode = workspace.mode;
    const startedProvider = activeProvider;
    setActivity("analyzing");
    setLiveProgress(startedMode === "live_sonnet" ? "queued" : null);
    setPersonalizationView("guided");
    setWorkspace((current) => beginModeAnalysis({ ...current, goal: startedGoal }));
    try {
      const result = await startedProvider.analyze(
        {
          goal: startedGoal,
          portalUrl: workspace.portalUrl,
          scenarioId: workspace.scenarioId,
          userState: workspace.userState,
        },
        {
          onProgress: (progress) => {
            if (runIdRef.current === runId && startedMode === "live_sonnet") {
              setLiveProgress(progress.phase);
            }
          },
        },
      );
      if (runIdRef.current !== runId) return;
      setWorkspace((current) =>
        applyAnalysisResult(current, startedMode, result, "analysis"),
      );
    } catch (caught) {
      if (runIdRef.current !== runId) return;
      setWorkspace((current) =>
        failModeAnalysis(
          current,
          startedMode,
          errorMessage(caught),
          startedMode === "live_sonnet" ? liveErrorKind(caught) : "analysis",
        ),
      );
    } finally {
      if (runIdRef.current === runId) {
        busyRef.current = false;
        setActivity(null);
        setLiveProgress(null);
      }
    }
  }

  async function replan(userState = workspace.userState): Promise<void> {
    if (workspace.analysis === null || busyRef.current) return;
    busyRef.current = true;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const startedMode = workspace.mode;
    const startedProvider = activeProvider;
    setActivity("replanning");
    setWorkspace((current) => ({ ...current, error: null, errorKind: null }));
    const nextUserState: UserState = {
      schemaVersion: 1,
      revision: workspace.analysis.plan.userStateRevision + 1,
      facts: { ...userState.facts },
    };
    try {
      const result = await startedProvider.replan(workspace.analysis.sessionId, nextUserState);
      if (runIdRef.current !== runId) return;
      setWorkspace((current) =>
        applyAnalysisResult(current, startedMode, result, "replan"),
      );
    } catch (caught) {
      if (runIdRef.current !== runId) return;
      setWorkspace((current) =>
        failModeReplan(current, startedMode, errorMessage(caught)),
      );
    } finally {
      if (runIdRef.current === runId) {
        busyRef.current = false;
        setActivity(null);
      }
    }
  }

  function answerGuidedFact(key: string, value: JsonScalar | undefined): void {
    if (workspace.analysis === null || busyRef.current) return;
    const nextUserState = updateUserFact(workspace.userState, key, value);
    setWorkspace((current) => ({
      ...current,
      userState: nextUserState,
      isDirty: true,
    }));
    void replan(nextUserState);
  }

  function stopLivePolling(): void {
    if (workspace.mode !== "live_sonnet" || activity !== "analyzing") return;
    runIdRef.current += 1;
    busyRef.current = false;
    activeProvider.stop?.("user_cancelled");
    setActivity(null);
    setLiveProgress(null);
    setWorkspace((current) => ({
      ...current,
      analysis: null,
      originalAnalysis: null,
      isDirty: false,
      error:
        "Analysis polling stopped in this browser. The backend extraction job was not cancelled.",
      errorKind: "live_stopped",
    }));
  }

  const analyzeLabel = isLiveRecoveryBlocked
    ? "Recovery blocked"
    : canResumeLive
      ? "Resume analysis"
      : canRetryAmbiguousLive
        ? "Retry analysis"
        : "Analyze Website";

  return (
    <div className="app-shell" id="top">
      <AppHeader
        portalName={workspace.analysis?.portalName ?? "Northstar Mock Bank"}
        modeLabel={workspace.analysis?.source.label ?? configured.label}
        analyzeLabel={analyzeLabel}
        reanalyzeLabel="Analyze Website Again"
        busyLabel={activity === "replanning" ? "Replanning" : "Analyzing website"}
        isBusy={isBusy}
        isAnalyzeDisabled={isLiveRecoveryBlocked}
        hasAnalysis={workspace.analysis !== null}
        onAnalyze={() => void analyze()}
      />

      <main>
        <section className="hero">
          <div>
            <span className="hero-kicker">Policy-aware browser guidance</span>
            <h1>
              AI agents know where to click.
              <br />
              <span>Bureaucracy Slayer verifies whether they should.</span>
            </h1>
          </div>
          <div className="trust-summary">
            <span>Evidence-bound</span>
            <span>Fail-closed</span>
            <span>Guidance only</span>
          </div>
        </section>

        <div className={`mode-notice mode-notice--${workspace.mode}`} data-testid="analysis-provenance">
          <strong>{workspace.analysis?.source.label ?? configured.label}</strong>
          <span>
            {workspace.analysis === null
              ? isLiveRecoveryBlocked
                ? "Stored recovery metadata failed validation. No backend request will be sent in this browser session."
                : canResumeLive
                  ? "Resume the retained backend job without starting another extraction."
                  : canRetryAmbiguousLive
                    ? "Retry the same idempotent start request; its request ID is retained to prevent duplicate work."
                    : configured.detail
              : workspace.analysis.source.kind === "offline_mock_replay"
                ? "A sanitized deterministic mock response was independently hash-checked, audited, and evidence-validated. It is not a fresh Sonnet extraction."
                : workspace.analysis.source.kind === "live_extraction"
                  ? "The fresh result passed local hash, semantic-audit, and evidence-validation checks. Fact changes now replan locally."
                  : `${workspace.analysis.source.label} is explicitly replayed data and is not presented as a fresh live extraction.`}
          </span>
        </div>

        <AnalysisSetup
          goal={workspace.goal}
          portalUrl={workspace.portalUrl}
          goalEditable={workspace.mode === "live_sonnet"}
          isBusy={isBusy || canResumeLive || canRetryAmbiguousLive}
          hasAnalysis={workspace.analysis !== null}
          onGoalChange={(goal) => {
            if (!isBusy && !canResumeLive && !canRetryAmbiguousLive) {
              setWorkspace((current) => changeLiveGoal(current, goal));
            }
          }}
          goalNote={
            workspace.mode === "live_sonnet"
              ? "Your goal is sent to the bounded analysis pipeline; the fictional portal stays server-owned."
              : "This goal belongs to the selected recorded demonstration."
          }
        />

        {workspace.error === null ? null : (
          <div className="error-banner" role="alert">
            <strong>
              {workspace.errorKind === "live_stopped"
                ? "Browser activity stopped locally"
                : workspace.errorKind === "live_integrity"
                  ? "Analysis result rejected"
                  : workspace.errorKind === "live_operational"
                    ? "Website analysis failed operationally"
                    : workspace.errorKind === "replan"
                      ? "Local replan failed"
                      : "Analysis stopped"}
            </strong>
            <span>{workspace.error}</span>
          </div>
        )}

        <div className="workspace-grid">
          <aside>
            {workspace.analysis === null ? (
              <PersonalizationPlaceholder
                state={livePersonalizationState(
                  activity,
                  workspace.errorKind,
                  isLiveRecoveryBlocked,
                )}
              />
            ) : (
              <>
                <PersonalizationViewToggle
                  view={personalizationView}
                  guidedAvailable
                  disabled={isBusy}
                  onChange={setPersonalizationView}
                />
                {personalizationView === "guided" ? (
                  <GuidedPersonalization
                    analysis={workspace.analysis}
                    userState={workspace.userState}
                    isBusy={isBusy}
                    onAnswer={answerGuidedFact}
                  />
                ) : (
                  <UserStatePanel
                    model={workspace.analysis.model}
                    userState={workspace.userState}
                    missingFacts={missingFacts}
                    isDirty={workspace.isDirty}
                    isBusy={isBusy}
                    onFactChange={changeFact}
                    onReplan={() => void replan()}
                  />
                )}
              </>
            )}

            <div className="scenario-context" data-testid="source-context">
              <span>Data provenance</span>
              <strong>{workspace.analysis?.source.label ?? configured.label}</strong>
              <p>
                {workspace.analysis === null
                  ? "Questions appear in this column after the website is analyzed."
                  : "Further answers use only the deterministic evaluator and planner."}
              </p>
              {workspace.analysis === null ? null : (
                <details className="technical-details">
                  <summary>Snapshot identifier</summary>
                  <code>{workspace.analysis.snapshot.id}</code>
                </details>
              )}
            </div>
          </aside>

          <div className="results-column">
            {isBusy ? (
              workspace.mode === "live_sonnet" && activity === "analyzing" ? (
                <LiveProgressPanel
                  phase={liveProgress ?? "queued"}
                  onStop={stopLivePolling}
                />
              ) : (
                <section className="panel progress-panel" aria-live="polite">
                  <div className="progress-track" aria-hidden="true"><span /></div>
                  <p className="eyebrow">{analysisProgressLabel(workspace.mode, activity)}</p>
                  <h2>
                    {activity === "replanning"
                      ? "Re-evaluating rules against your updated facts…"
                      : "Binding website actions to policy evidence…"}
                  </h2>
                  <p>No financial action is being executed.</p>
                </section>
              )
            ) : workspace.analysis === null ? (
              <section className="panel empty-results">
                <div className="empty-results__graphic" aria-hidden="true">
                  <span>1</span><i /><span>2</span><i /><span>3</span>
                </div>
                <p className="eyebrow">Ready when you are</p>
                <h2>Turn captured policies into a verified action route</h2>
                <p>
                  Analyze the website, then answer the questions that the verified rules actually use.
                </p>
              </section>
            ) : (
              <>
                <SafeRoutePanel analysis={workspace.analysis} />
                <DecisionIntelligencePanel analysis={workspace.analysis} />
                {workspace.originalAnalysis !== null &&
                workspace.originalAnalysis.plan.id !== workspace.analysis.plan.id ? (
                  <PlanComparison original={workspace.originalAnalysis} current={workspace.analysis} />
                ) : null}
                <ExcludedActionsPanel analysis={workspace.analysis} />
                <PolicyEvidencePanel analysis={workspace.analysis} />
              </>
            )}
          </div>
        </div>
      </main>

      <footer className="app-footer">
        <strong>Bureaucracy Slayer</strong>
        <span>
          Evidence-linked guidance is not guaranteed safety, legal advice, or authorization to act.
        </span>
        <code>snapshot: {workspace.analysis?.snapshot.id ?? "analysis_pending"}</code>
      </footer>
    </div>
  );
}
