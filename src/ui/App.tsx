import { useMemo, useState } from "react";

import type { JsonScalar, UserState } from "../contracts/index.js";
import { FixtureDemoProvider } from "./adapters/fixtureDemoProvider.js";
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
import { createModeWorkspaceState } from "./modeState.js";
import type {
  DemoDataProvider,
  DemoMode,
  DemoScenario,
  DemoScenarioId,
} from "./types.js";
import { updateUserFact } from "./viewModel.js";

const fixtureProvider = new FixtureDemoProvider({ latencyMs: 650 });
const recordedProvider = new RecordedExtractionProvider({ latencyMs: 650 });

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

export function App({ provider, providers }: AppProps) {
  const [workspace, setWorkspace] = useState(() => createModeWorkspaceState("verified_fixture"));
  const [activity, setActivity] = useState<"analyzing" | "replanning" | null>(null);
  const isBusy = activity !== null;
  const activeProvider =
    providers?.[workspace.mode] ??
    (workspace.mode === "verified_fixture" ? provider ?? fixtureProvider : recordedProvider);

  const model =
    workspace.analysis?.model ??
    (workspace.mode === "recorded_sonnet"
      ? recordedExtractionBundle.procedureModel
      : demoProcedureModel);
  const missingFacts = workspace.analysis?.plan.missingFacts ?? [];
  const selectedScenario = useMemo(
    () => scenarioById(workspace.scenarioId),
    [workspace.scenarioId],
  );

  function changeMode(mode: DemoMode): void {
    if (mode === workspace.mode) return;
    setWorkspace(createModeWorkspaceState(mode));
    setActivity(null);
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
    }));
  }

  function changeGoal(nextGoal: string): void {
    if (workspace.mode === "recorded_sonnet") return;
    setWorkspace((current) => ({
      ...current,
      goal: nextGoal,
      analysis: null,
      originalAnalysis: null,
      isDirty: false,
      error: null,
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
    setActivity("analyzing");
    setWorkspace((current) => ({ ...current, error: null }));
    try {
      const result = await activeProvider.analyze({
        goal: workspace.goal,
        portalUrl: workspace.portalUrl,
        scenarioId: workspace.scenarioId,
        userState: workspace.userState,
      });
      setWorkspace((current) => ({
        ...current,
        analysis: result,
        originalAnalysis: result,
        userState: result.userState,
        isDirty: false,
      }));
    } catch (caught) {
      setWorkspace((current) => ({ ...current, error: errorMessage(caught) }));
    } finally {
      setActivity(null);
    }
  }

  async function replan(): Promise<void> {
    if (workspace.analysis === null) return;
    setActivity("replanning");
    setWorkspace((current) => ({ ...current, error: null }));
    const nextUserState: UserState = {
      schemaVersion: 1,
      revision: workspace.analysis.plan.userStateRevision + 1,
      facts: { ...workspace.userState.facts },
    };
    try {
      const result = await activeProvider.replan(workspace.analysis.sessionId, nextUserState);
      setWorkspace((current) => ({
        ...current,
        analysis: result,
        userState: nextUserState,
        isDirty: false,
      }));
    } catch (caught) {
      setWorkspace((current) => ({ ...current, error: errorMessage(caught) }));
    } finally {
      setActivity(null);
    }
  }

  return (
    <div className="app-shell" id="top">
      <AppHeader
        portalName={workspace.analysis?.portalName ?? (workspace.mode === "recorded_sonnet" ? "Recorded Sonnet" : "Northstar Mock Portal")}
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

        <ModeSelector mode={workspace.mode} disabled={isBusy} onChange={changeMode} />

        <div className={`mode-notice mode-notice--${workspace.mode}`} data-testid="active-mode">
          <strong>{workspace.mode === "recorded_sonnet" ? "Recorded Sonnet extraction" : "Verified fixture"}</strong>
          <span>
            {workspace.mode === "recorded_sonnet"
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
          goalLocked={workspace.mode === "recorded_sonnet"}
          showScenarios={workspace.mode === "verified_fixture"}
          lockedGoalNote="Locked to the exact goal and portal used for the saved extraction. Change modes to explore fixture scenarios."
          onGoalChange={changeGoal}
          onScenarioChange={changeScenario}
        />

        {workspace.error === null ? null : (
          <div className="error-banner" role="alert">
            <strong>Analysis stopped</strong>
            <span>{workspace.error}</span>
          </div>
        )}

        <div className="workspace-grid">
          <aside>
            <UserStatePanel
              model={model}
              userState={workspace.userState}
              missingFacts={missingFacts}
              isDirty={workspace.isDirty}
              isBusy={isBusy}
              onFactChange={changeFact}
              onReplan={() => void replan()}
            />
            {workspace.mode === "verified_fixture" ? (
              <div className="scenario-context">
                <span>{selectedScenario.experiment}</span>
                <strong>{selectedScenario.label}</strong>
                <p>{selectedScenario.description}</p>
              </div>
            ) : (
              <div className="scenario-context">
                <span>Previously recorded</span>
                <strong>{recordedExtractionBundle.provenance.modelName}</strong>
                <p>
                  Recorded {new Date(recordedExtractionBundle.provenance.recordedAt).toLocaleString()}.
                  The snapshot and model remain immutable while user facts may be replanned.
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
                  {activity === "replanning" ? "Deterministic replan" : "Fixture analysis"}
                </p>
                <h2>
                  {activity === "replanning"
                    ? "Re-evaluating rules against your updated facts…"
                    : "Binding website actions to policy evidence…"}
                </h2>
                <p>No financial action is being executed.</p>
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
                  Analyze website
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
        <code>snapshot: {workspace.analysis?.snapshot.id ?? (workspace.mode === "recorded_sonnet" ? recordedExtractionBundle.identity.snapshotId : "fixture_pending")}</code>
      </footer>
    </div>
  );
}
