import { useEffect, useMemo, useRef, useState } from "react";

import type { JsonScalar, UserState } from "../contracts/index.js";
import { FixtureDemoProvider } from "./adapters/fixtureDemoProvider.js";
import {
  LiveExtractionClientError,
  LiveExtractionProvider,
} from "./adapters/liveExtractionProvider.js";
import { LiveArtifactIntegrityError } from "./adapters/liveArtifactVerification.js";
import {
  RecordedExtractionProvider,
  recordedExtractionBundle,
} from "./adapters/recordedExtractionProvider.js";
import { AnalysisSetup } from "./components/AnalysisSetup.js";
import { AppHeader } from "./components/AppHeader.js";
import { DecisionIntelligencePanel } from "./components/DecisionIntelligencePanel.js";
import { ExcludedActionsPanel } from "./components/ExcludedActionsPanel.js";
import { GuidedPersonalization } from "./components/GuidedPersonalization.js";
import { PlanComparison } from "./components/PlanComparison.js";
import { ModeSelector } from "./components/ModeSelector.js";
import { LiveProgressPanel } from "./components/LiveProgressPanel.js";
import {
  PersonalizationPlaceholder,
  type PersonalizationPlaceholderState,
} from "./components/PersonalizationPlaceholder.js";
import { PolicyEvidencePanel } from "./components/PolicyEvidencePanel.js";
import { PersonalizationViewToggle } from "./components/PersonalizationViewToggle.js";
import { SafeRoutePanel } from "./components/SafeRoutePanel.js";
import { UserStatePanel } from "./components/UserStatePanel.js";
import {
  demoProcedureModel,
  demoScenarios,
} from "./fixtures/demoArtifacts.js";
import type { PersonalizationView } from "./guidedPersonalization.js";
import {
  applyAnalysisResult,
  beginModeAnalysis,
  createModeWorkspaceState,
  failModeAnalysis,
  failModeReplan,
  stopLiveModeForNavigation,
} from "./modeState.js";
import type {
  DemoDataProvider,
  DemoMode,
  DemoScenario,
  DemoScenarioId,
  LiveExtractionPhase,
  LiveResumeState,
} from "./types.js";
import { updateUserFact } from "./viewModel.js";

const fixtureProvider = new FixtureDemoProvider({ latencyMs: 650 });
const recordedProvider = new RecordedExtractionProvider({ latencyMs: 650 });
const liveProvider = new LiveExtractionProvider();

type Activity = "analyzing" | "replanning" | null;

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
  initialMode?: DemoMode;
  provider?: DemoDataProvider;
  providers?: Partial<Readonly<Record<DemoMode, DemoDataProvider>>>;
}>;

function scenarioById(id: DemoScenarioId): DemoScenario {
  const scenario = demoScenarios.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`Demo scenario ${id} is unavailable.`);
  return scenario;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The demo could not complete this request.";
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
      error.code === "PORTAL_MISMATCH"
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

export function App({ initialMode = "verified_fixture", provider, providers }: AppProps) {
  const [workspace, setWorkspace] = useState(() => createModeWorkspaceState(initialMode));
  const [activity, setActivity] = useState<Activity>(null);
  const [liveProgress, setLiveProgress] = useState<LiveExtractionPhase | null>(null);
  const [personalizationView, setPersonalizationView] =
    useState<PersonalizationView>("guided");
  const runIdRef = useRef(0);
  const busyRef = useRef(false);
  const navigationInterruptedRef = useRef(false);
  const isBusy = activity !== null;
  const activeProvider: DemoDataProvider =
    providers?.[workspace.mode] ??
    (workspace.mode === "verified_fixture"
      ? provider ?? fixtureProvider
      : workspace.mode === "recorded_sonnet"
        ? recordedProvider
        : liveProvider);
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

  const model =
    workspace.analysis?.model ??
    (workspace.mode !== "verified_fixture"
      ? recordedExtractionBundle.procedureModel
      : demoProcedureModel);
  const missingFacts = workspace.analysis?.plan.missingFacts ?? [];
  const selectedScenario = useMemo(
    () => scenarioById(workspace.scenarioId),
    [workspace.scenarioId],
  );

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

  function changeMode(mode: DemoMode): void {
    if (mode === workspace.mode) return;
    runIdRef.current += 1;
    busyRef.current = false;
    if (workspace.mode === "live_sonnet") {
      activeProvider.stop?.("mode_changed");
    }
    setWorkspace(createModeWorkspaceState(mode));
    setPersonalizationView("guided");
    setActivity(null);
    setLiveProgress(null);
  }

  function changeScenario(nextScenarioId: DemoScenarioId): void {
    const nextScenario = scenarioById(nextScenarioId);
    setWorkspace((current) => ({
      ...current,
      scenarioId: nextScenarioId,
      userState: nextScenario.defaultUserState,
      analysis: null,
      originalAnalysis: null,
      isDirty: false,
      error: null,
      errorKind: null,
    }));
    setPersonalizationView("guided");
  }

  function changeGoal(nextGoal: string): void {
    if (workspace.mode !== "verified_fixture") return;
    setWorkspace((current) => ({
      ...current,
      goal: nextGoal,
      analysis: null,
      originalAnalysis: null,
      isDirty: false,
      error: null,
      errorKind: null,
    }));
  }

  function changeFact(key: string, value: JsonScalar | undefined): void {
    setWorkspace((current) => ({
      ...current,
      userState: updateUserFact(current.userState, key, value),
      isDirty: current.analysis !== null,
    }));
  }

  async function analyze(): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const startedMode = workspace.mode;
    const startedProvider = activeProvider;
    setActivity("analyzing");
    setLiveProgress(startedMode === "live_sonnet" ? "queued" : null);
    setWorkspace(beginModeAnalysis);
    try {
      const result = await startedProvider.analyze(
        {
          goal: workspace.goal,
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
        "Live polling stopped in this browser. The backend extraction job was not cancelled.",
      errorKind: "live_stopped",
    }));
  }

  return (
    <div className="app-shell" id="top">
      <AppHeader
        portalName={
          workspace.analysis?.portalName ??
          (workspace.mode === "recorded_sonnet"
            ? "Recorded Sonnet"
            : workspace.mode === "live_sonnet"
              ? "Northstar Mock Bank (live)"
              : "Northstar Mock Portal")
        }
        modeLabel={
          workspace.mode === "live_sonnet"
            ? "Live Sonnet"
            : workspace.mode === "recorded_sonnet"
              ? "Recorded Sonnet"
              : "Verified fixture"
        }
        analyzeLabel={
          workspace.mode === "live_sonnet"
            ? isLiveRecoveryBlocked
              ? "Live recovery blocked"
              : canResumeLive
              ? "Resume live extraction"
              : canRetryAmbiguousLive
                ? "Retry live extraction"
                : "Start live extraction"
            : "Analyze website"
        }
        reanalyzeLabel={workspace.mode === "live_sonnet" ? "Start new extraction" : "Analyze again"}
        busyLabel={activity === "replanning" ? "Replanning" : workspace.mode === "live_sonnet" ? "Extracting" : "Analyzing"}
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

        <ModeSelector mode={workspace.mode} disabled={false} onChange={changeMode} />

        <div className={`mode-notice mode-notice--${workspace.mode}`} data-testid="active-mode">
          <strong>
            {workspace.mode === "live_sonnet"
              ? workspace.analysis?.plan.status === "review_required"
                ? "Extraction completed with review required"
                : workspace.analysis === null
                  ? "Live Sonnet extraction"
                  : "Live extraction completed"
              : workspace.mode === "recorded_sonnet"
                ? "Recorded Sonnet extraction"
                : "Verified fixture"}
          </strong>
          <span>
            {workspace.mode === "live_sonnet"
              ? workspace.analysis?.plan.status === "review_required"
                ? "The live run completed operationally, but semantic or evidence review gates prevent a ready recommendation."
                : workspace.analysis === null
                  ? isLiveRecoveryBlocked
                    ? "Stored Live recovery metadata failed validation. No backend request will be sent. Close this tab to start a new browser session."
                    : canResumeLive
                    ? "The backend job is retained. Resume polling without starting another paid extraction; stopping locally did not cancel backend work."
                    : canRetryAmbiguousLive
                      ? "Retry the same idempotent start request. The backend may already have accepted it, so the request ID is reused to prevent duplicate paid work."
                      : "This mode collects the controlled portal and runs both Sonnet extraction stages now. Returned artifacts are independently verified in the browser."
                  : "The live result passed local hash, semantic-audit, and evidence-validation checks. Fact changes now re-evaluate locally without another Sonnet call."
              : workspace.mode === "recorded_sonnet"
              ? workspace.analysis?.plan.status === "review_required" && workspace.analysis.evidence.issues.some((issue) => issue.code === "SEMANTIC_REVIEW_REQUIRED")
                ? "Sonnet extracted a policy model, but some permissions require semantic review. Bureaucracy Slayer withheld the associated actions."
                : "Sonnet extraction happened previously. This mode only revalidates evidence and evaluates or replans locally; it makes no model or browser calls."
              : "This hand-checked fixture preserves the safe cancellation, prohibition, unknown-fact, replanning, and evidence-failure demonstrations."}
          </span>
        </div>

        <AnalysisSetup
          goal={workspace.goal}
          portalUrl={workspace.portalUrl}
          scenarios={demoScenarios}
          selectedScenarioId={workspace.scenarioId}
          isBusy={isBusy}
          hasAnalysis={workspace.analysis !== null}
          goalLocked={workspace.mode !== "verified_fixture"}
          showScenarios={workspace.mode === "verified_fixture"}
          lockedGoalNote={
            workspace.mode === "live_sonnet"
              ? "Locked to the server-owned goal and controlled portal. Neither value is sent as a browser override."
              : "Locked to the exact goal and portal used for the saved extraction. Change modes to explore fixture scenarios."
          }
          onGoalChange={changeGoal}
          onScenarioChange={changeScenario}
        />

        {workspace.error === null ? null : (
          <div className="error-banner" role="alert">
            <strong>
              {workspace.errorKind === "live_stopped"
                ? "Live browser activity stopped locally"
                : workspace.errorKind === "live_integrity"
                  ? "Live result rejected"
                  : workspace.errorKind === "live_operational"
                    ? "Live extraction failed operationally"
                    : workspace.errorKind === "replan"
                      ? "Local replan failed"
                    : "Analysis stopped"}
            </strong>
            <span>{workspace.error}</span>
          </div>
        )}

        <div className="workspace-grid">
          <aside>
            {workspace.mode !== "live_sonnet" || workspace.analysis !== null ? (
              <>
                <PersonalizationViewToggle
                  view={workspace.analysis === null ? "all_facts" : personalizationView}
                  guidedAvailable={workspace.analysis !== null}
                  disabled={isBusy}
                  onChange={setPersonalizationView}
                />
                {workspace.analysis !== null && personalizationView === "guided" ? (
                  <GuidedPersonalization
                    analysis={workspace.analysis}
                    userState={workspace.userState}
                    isBusy={isBusy}
                    onAnswer={answerGuidedFact}
                  />
                ) : (
                  <UserStatePanel
                    model={model}
                    userState={workspace.userState}
                    missingFacts={missingFacts}
                    isDirty={workspace.isDirty}
                    isBusy={isBusy}
                    onFactChange={changeFact}
                    onReplan={() => void replan()}
                  />
                )}
              </>
            ) : (
              <PersonalizationPlaceholder
                state={livePersonalizationState(
                  activity,
                  workspace.errorKind,
                  isLiveRecoveryBlocked,
                )}
              />
            )}
            {workspace.mode === "verified_fixture" ? (
              <div className="scenario-context">
                <span>{selectedScenario.experiment}</span>
                <strong>{selectedScenario.label}</strong>
                <p>{selectedScenario.description}</p>
              </div>
            ) : workspace.mode === "recorded_sonnet" ? (
              <div className="scenario-context">
                <span>Previously recorded</span>
                <strong>{recordedExtractionBundle.provenance.modelName}</strong>
                <p>
                  Recorded {new Date(recordedExtractionBundle.provenance.recordedAt).toLocaleString()}.
                  The snapshot and model remain immutable while user facts may be replanned.
                </p>
              </div>
            ) : (
              <div className="scenario-context">
                <span>
                  {isBusy
                    ? "Live extraction running now"
                    : isLiveRecoveryBlocked
                      ? "Live recovery blocked"
                    : canResumeLive
                      ? "Live polling paused"
                      : canRetryAmbiguousLive
                        ? "Live start retry available"
                        : "Live-only session"}
                </span>
                <strong>
                  {workspace.analysis?.source.modelName ??
                    (isLiveRecoveryBlocked
                      ? "Stored metadata rejected"
                      : canResumeLive
                      ? "Backend job retained"
                      : canRetryAmbiguousLive
                        ? "Idempotent request retained"
                        : "Facts unlock after verified extraction")}
                </strong>
                <p>
                  {workspace.analysis === null
                    ? isLiveRecoveryBlocked
                      ? "The stored value was invalid, tampered with, or too old for a safe same-ID retry. No new extraction can start in this tab."
                      : canResumeLive
                      ? "Resume the retained job without another POST. The browser has not claimed or requested backend cancellation."
                      : canRetryAmbiguousLive
                        ? "Retry with the same request ID. A repeated POST remains idempotent and must not create duplicate paid work."
                        : "This session starts with no inherited facts or result. Stopping or leaving only stops browser polling; it does not cancel backend work."
                    : `Completed ${new Date(workspace.analysis.source.recordedAt ?? "").toLocaleString()}. Further fact changes use only the deterministic local engine.`}
                </p>
              </div>
            )}
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
                  <div className="progress-track" aria-hidden="true">
                    <span />
                  </div>
                  <p className="eyebrow">
                    {activity === "replanning" ? "Deterministic replan" : "Fixture analysis"}
                  </p>
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
                  <span>1</span>
                  <i />
                  <span>2</span>
                  <i />
                  <span>3</span>
                </div>
                <p className="eyebrow">Ready when you are</p>
                <h2>Turn captured policies into a verified action route</h2>
                <p>
                  Start the analysis to inspect safe steps, source citations, and the actions the
                  planner excluded.
                </p>
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => void analyze()}
                  disabled={isLiveRecoveryBlocked}
                >
                  {workspace.mode === "live_sonnet"
                    ? isLiveRecoveryBlocked
                      ? "Live recovery blocked"
                      : canResumeLive
                      ? "Resume live extraction"
                      : canRetryAmbiguousLive
                        ? "Retry live extraction"
                        : "Start live extraction"
                    : "Analyze website"}
                </button>
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
        <code>
          snapshot:{" "}
          {workspace.analysis?.snapshot.id ??
            (workspace.mode === "recorded_sonnet"
              ? recordedExtractionBundle.identity.snapshotId
              : workspace.mode === "live_sonnet"
                ? "live_pending"
                : "fixture_pending")}
        </code>
      </footer>
    </div>
  );
}
