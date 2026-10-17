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
import { PlanComparison } from "./components/PlanComparison.js";
import { ModeSelector } from "./components/ModeSelector.js";
import { PolicyEvidencePanel } from "./components/PolicyEvidencePanel.js";
import { SafeRoutePanel } from "./components/SafeRoutePanel.js";
import { UserStatePanel } from "./components/UserStatePanel.js";
import {
  demoProcedureModel,
  demoScenarios,
} from "./fixtures/demoArtifacts.js";
import {
  applyAnalysisResult,
  beginModeAnalysis,
  createModeWorkspaceState,
  failModeAnalysis,
} from "./modeState.js";
import type {
  DemoDataProvider,
  DemoMode,
  DemoScenario,
  DemoScenarioId,
  LiveExtractionPhase,
} from "./types.js";
import { updateUserFact } from "./viewModel.js";

const fixtureProvider = new FixtureDemoProvider({ latencyMs: 650 });
const recordedProvider = new RecordedExtractionProvider({ latencyMs: 650 });
const liveProvider = new LiveExtractionProvider();

type AppProps = Readonly<{
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

const livePhaseCopy: Readonly<
  Record<LiveExtractionPhase, Readonly<{ eyebrow: string; title: string }>>
> = {
  queued: {
    eyebrow: "Queued",
    title: "Waiting for the bounded extraction worker…",
  },
  collecting: {
    eyebrow: "Collecting",
    title: "Observing the controlled portal with Playwright…",
  },
  selecting_sources: {
    eyebrow: "Source selection",
    title: "Selecting goal-scoped pages, evidence blocks, and actions…",
  },
  extracting_policy: {
    eyebrow: "Policy extraction · Sonnet Stage 1",
    title: "Extracting policy rules from observed sources…",
  },
  mapping_procedure: {
    eyebrow: "Procedure mapping · Sonnet Stage 2",
    title: "Mapping the policy rules to observed website actions…",
  },
  validating: {
    eyebrow: "Evidence validation",
    title: "Converting, auditing, and validating the extracted model…",
  },
  complete: {
    eyebrow: "Succeeded",
    title: "Verifying the returned artifacts again in this browser…",
  },
  failed: {
    eyebrow: "Failed",
    title: "Live extraction failed operationally.",
  },
};

export function App({ provider, providers }: AppProps) {
  const [workspace, setWorkspace] = useState(() => createModeWorkspaceState("verified_fixture"));
  const [activity, setActivity] = useState<"analyzing" | "replanning" | null>(null);
  const [liveProgress, setLiveProgress] = useState<LiveExtractionPhase | null>(null);
  const runIdRef = useRef(0);
  const busyRef = useRef(false);
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
  const canResumeLive =
    workspace.mode === "live_sonnet" && activeProvider.canResume?.() === true;

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
      runIdRef.current += 1;
      busyRef.current = false;
      activeProviderRef.current.stop?.("navigation");
    }
    window.addEventListener("pagehide", stopForNavigation);
    return () => {
      window.removeEventListener("pagehide", stopForNavigation);
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

  async function replan(): Promise<void> {
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
      facts: { ...workspace.userState.facts },
    };
    try {
      const result = await startedProvider.replan(workspace.analysis.sessionId, nextUserState);
      if (runIdRef.current !== runId) return;
      setWorkspace((current) =>
        applyAnalysisResult(current, startedMode, result, "replan"),
      );
    } catch (caught) {
      if (runIdRef.current !== runId) return;
      setWorkspace((current) => ({
        ...current,
        error: errorMessage(caught),
        errorKind:
          startedMode === "live_sonnet" ? liveErrorKind(caught) : "analysis",
      }));
    } finally {
      if (runIdRef.current === runId) {
        busyRef.current = false;
        setActivity(null);
      }
    }
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
            ? canResumeLive
              ? "Resume live extraction"
              : "Start live extraction"
            : "Analyze website"
        }
        reanalyzeLabel={workspace.mode === "live_sonnet" ? "Start new extraction" : "Analyze again"}
        busyLabel={activity === "replanning" ? "Replanning" : workspace.mode === "live_sonnet" ? "Extracting" : "Analyzing"}
        isBusy={isBusy}
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
                  ? canResumeLive
                    ? "The backend job is retained. Resume polling without starting another paid extraction; stopping locally did not cancel backend work."
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
                ? "Live polling stopped locally"
                : workspace.errorKind === "live_integrity"
                  ? "Live result rejected"
                  : workspace.errorKind === "live_operational"
                    ? "Live extraction failed operationally"
                    : "Analysis stopped"}
            </strong>
            <span>{workspace.error}</span>
          </div>
        )}

        <div className="workspace-grid">
          <aside>
            {workspace.mode !== "live_sonnet" || workspace.analysis !== null ? (
              <UserStatePanel
                model={model}
                userState={workspace.userState}
                missingFacts={missingFacts}
                isDirty={workspace.isDirty}
                isBusy={isBusy}
                onFactChange={changeFact}
                onReplan={() => void replan()}
              />
            ) : null}
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
                    : canResumeLive
                      ? "Live polling paused"
                      : "Live-only session"}
                </span>
                <strong>
                  {workspace.analysis?.source.modelName ??
                    (canResumeLive
                      ? "Backend job retained"
                      : "Facts unlock after verified extraction")}
                </strong>
                <p>
                  {workspace.analysis === null
                    ? canResumeLive
                      ? "Resume the retained job without another POST. The browser has not claimed or requested backend cancellation."
                      : "This session starts with no inherited facts or result. Stopping or leaving only stops browser polling; it does not cancel backend work."
                    : `Completed ${new Date(workspace.analysis.source.recordedAt ?? "").toLocaleString()}. Further fact changes use only the deterministic local engine.`}
                </p>
              </div>
            )}
          </aside>

          <div className="results-column">
            {isBusy ? (
              <section className="panel progress-panel" aria-live="polite">
                <div className="progress-track">
                  <span />
                </div>
                <p className="eyebrow">
                  {activity === "replanning"
                    ? "Deterministic replan"
                    : workspace.mode === "live_sonnet"
                      ? livePhaseCopy[liveProgress ?? "queued"].eyebrow
                      : "Fixture analysis"}
                </p>
                <h2>
                  {activity === "replanning"
                    ? "Re-evaluating rules against your updated facts…"
                    : workspace.mode === "live_sonnet"
                      ? livePhaseCopy[liveProgress ?? "queued"].title
                      : "Binding website actions to policy evidence…"}
                </h2>
                <p>
                  {workspace.mode === "live_sonnet" && activity === "analyzing"
                    ? "Live extraction is running now. Progress is phase-based; no completion estimate is available."
                    : "No financial action is being executed."}
                </p>
                {workspace.mode === "live_sonnet" && activity === "analyzing" ? (
                  <button className="button button--secondary" type="button" onClick={stopLivePolling}>
                    Stop watching
                  </button>
                ) : null}
              </section>
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
                <button className="button button--primary" type="button" onClick={() => void analyze()}>
                  {workspace.mode === "live_sonnet"
                    ? canResumeLive
                      ? "Resume live extraction"
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
