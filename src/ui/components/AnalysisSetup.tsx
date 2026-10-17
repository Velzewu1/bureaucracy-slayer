import type { DemoScenario, DemoScenarioId } from "../types.js";

type AnalysisSetupProps = Readonly<{
  goal: string;
  portalUrl: string;
  scenarios: readonly DemoScenario[];
  selectedScenarioId: DemoScenarioId;
  isBusy: boolean;
  hasAnalysis: boolean;
  onGoalChange: (goal: string) => void;
  onScenarioChange: (scenarioId: DemoScenarioId) => void;
}>;

export function AnalysisSetup({
  goal,
  portalUrl,
  scenarios,
  selectedScenarioId,
  isBusy,
  hasAnalysis,
  onGoalChange,
  onScenarioChange,
}: AnalysisSetupProps) {
  return (
    <section className="panel setup-panel" aria-labelledby="goal-heading">
      <div className="panel-heading">
        <div>
          <span className="section-number">01</span>
          <div>
            <p className="eyebrow">Define the outcome</p>
            <h1 id="goal-heading">What do you need to resolve?</h1>
          </div>
        </div>
        <span className={`analysis-state ${hasAnalysis ? "analysis-state--complete" : ""}`}>
          {isBusy ? "Checking evidence…" : hasAnalysis ? "Analysis complete" : "Ready to analyze"}
        </span>
      </div>

      <label className="field-label" htmlFor="user-goal">
        Your goal
      </label>
      <textarea
        id="user-goal"
        className="goal-input"
        value={goal}
        onChange={(event) => onGoalChange(event.currentTarget.value)}
        rows={3}
        disabled={isBusy}
      />

      <div className="portal-field">
        <div>
          <span className="field-label">Portal URL</span>
          <code>{portalUrl}</code>
        </div>
        <span className="fictional-badge">Fictional test environment</span>
      </div>

      <fieldset className="scenario-fieldset" disabled={isBusy}>
        <legend>Presentation scenario</legend>
        <p>Each scenario is a recorded, schema-validated fixture run through the real deterministic engine.</p>
        <div className="scenario-grid">
          {scenarios.map((scenario) => (
            <label
              className={`scenario-card ${
                scenario.id === selectedScenarioId ? "scenario-card--selected" : ""
              }`}
              key={scenario.id}
            >
              <input
                type="radio"
                name="scenario"
                value={scenario.id}
                checked={scenario.id === selectedScenarioId}
                onChange={() => onScenarioChange(scenario.id)}
              />
              <span className="scenario-card__experiment">{scenario.experiment}</span>
              <strong>{scenario.label}</strong>
              <span>{scenario.description}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </section>
  );
}
