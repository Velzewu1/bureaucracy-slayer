import { useMemo, useState } from "react";

import type { JsonScalar, UserState } from "../contracts/index.js";
import { FixtureDemoProvider } from "./adapters/fixtureDemoProvider.js";
import { AnalysisSetup } from "./components/AnalysisSetup.js";
import { AppHeader } from "./components/AppHeader.js";
import { ExcludedActionsPanel } from "./components/ExcludedActionsPanel.js";
import { PlanComparison } from "./components/PlanComparison.js";
import { PolicyEvidencePanel } from "./components/PolicyEvidencePanel.js";
import { SafeRoutePanel } from "./components/SafeRoutePanel.js";
import { UserStatePanel } from "./components/UserStatePanel.js";
import {
  demoGoal,
  demoProcedureModel,
  demoScenarios,
  demoSnapshot,
} from "./fixtures/demoArtifacts.js";
import type {
  DemoAnalysis,
  DemoDataProvider,
  DemoScenario,
  DemoScenarioId,
} from "./types.js";
import { updateUserFact } from "./viewModel.js";

const fixtureProvider = new FixtureDemoProvider({ latencyMs: 650 });

type AppProps = Readonly<{
  provider?: DemoDataProvider;
}>;

function scenarioById(id: DemoScenarioId): DemoScenario {
  const scenario = demoScenarios.find((candidate) => candidate.id === id);
  if (scenario === undefined) throw new Error(`Demo scenario ${id} is unavailable.`);
  return scenario;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The demo could not complete this request.";
}

export function App({ provider = fixtureProvider }: AppProps) {
  const [goal, setGoal] = useState(demoGoal);
  const [scenarioId, setScenarioId] = useState<DemoScenarioId>("dynamic-replanning");
  const [userState, setUserState] = useState<UserState>(
    () => scenarioById("dynamic-replanning").defaultUserState,
  );
  const [analysis, setAnalysis] = useState<DemoAnalysis | null>(null);
  const [originalAnalysis, setOriginalAnalysis] = useState<DemoAnalysis | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [activity, setActivity] = useState<"analyzing" | "replanning" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isBusy = activity !== null;

  const model = analysis?.model ?? demoProcedureModel;
  const missingFacts = analysis?.plan.missingFacts ?? [];
  const selectedScenario = useMemo(() => scenarioById(scenarioId), [scenarioId]);

  function changeScenario(nextScenarioId: DemoScenarioId): void {
    const nextScenario = scenarioById(nextScenarioId);
    setScenarioId(nextScenarioId);
    setUserState(nextScenario.defaultUserState);
    setAnalysis(null);
    setOriginalAnalysis(null);
    setIsDirty(false);
    setError(null);
  }

  function changeGoal(nextGoal: string): void {
    setGoal(nextGoal);
    if (analysis !== null) {
      setAnalysis(null);
      setOriginalAnalysis(null);
      setIsDirty(false);
    }
    setError(null);
  }

  function changeFact(key: string, value: JsonScalar | undefined): void {
    setUserState((current) => updateUserFact(current, key, value));
    if (analysis !== null) setIsDirty(true);
  }

  async function analyze(): Promise<void> {
    setActivity("analyzing");
    setError(null);
    try {
      const result = await provider.analyze({
        goal,
        portalUrl: demoSnapshot.rootUrl,
        scenarioId,
        userState,
      });
      setAnalysis(result);
      setOriginalAnalysis(result);
      setUserState({
        schemaVersion: 1,
        revision: result.plan.userStateRevision,
        facts: { ...userState.facts },
      });
      setIsDirty(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setActivity(null);
    }
  }

  async function replan(): Promise<void> {
    if (analysis === null) return;
    setActivity("replanning");
    setError(null);
    const nextUserState: UserState = {
      schemaVersion: 1,
      revision: analysis.plan.userStateRevision + 1,
      facts: { ...userState.facts },
    };
    try {
      const result = await provider.replan(analysis.sessionId, nextUserState);
      setAnalysis(result);
      setUserState(nextUserState);
      setIsDirty(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setActivity(null);
    }
  }

  return (
    <div className="app-shell" id="top">
      <AppHeader
        portalName="Northstar Mock Portal"
        isBusy={isBusy}
        hasAnalysis={analysis !== null}
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

        <div className="mode-notice">
          <strong>Recorded fixture mode</strong>
          <span>
            The website snapshot and extraction are saved demo artifacts. Policy evaluation and
            every replan run locally through the deterministic engine.
          </span>
        </div>

        <AnalysisSetup
          goal={goal}
          portalUrl={demoSnapshot.rootUrl}
          scenarios={demoScenarios}
          selectedScenarioId={scenarioId}
          isBusy={isBusy}
          hasAnalysis={analysis !== null}
          onGoalChange={changeGoal}
          onScenarioChange={changeScenario}
        />

        {error === null ? null : (
          <div className="error-banner" role="alert">
            <strong>Analysis stopped</strong>
            <span>{error}</span>
          </div>
        )}

        <div className="workspace-grid">
          <aside>
            <UserStatePanel
              model={model}
              userState={userState}
              missingFacts={missingFacts}
              isDirty={isDirty}
              isBusy={isBusy}
              onFactChange={changeFact}
              onReplan={() => void replan()}
            />
            <div className="scenario-context">
              <span>{selectedScenario.experiment}</span>
              <strong>{selectedScenario.label}</strong>
              <p>{selectedScenario.description}</p>
            </div>
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
            ) : analysis === null ? (
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
                <SafeRoutePanel analysis={analysis} />
                {originalAnalysis !== null &&
                originalAnalysis.plan.id !== analysis.plan.id ? (
                  <PlanComparison original={originalAnalysis} current={analysis} />
                ) : null}
                <ExcludedActionsPanel analysis={analysis} />
                <PolicyEvidencePanel analysis={analysis} />
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
        <code>snapshot: {demoSnapshot.id}</code>
      </footer>
    </div>
  );
}
