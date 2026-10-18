type AnalysisSetupProps = Readonly<{
  goal: string;
  portalUrl: string;
  goalEditable: boolean;
  isBusy: boolean;
  hasAnalysis: boolean;
  onGoalChange(goal: string): void;
  goalNote: string;
}>;

export function AnalysisSetup({
  goal,
  portalUrl,
  goalEditable,
  isBusy,
  hasAnalysis,
  onGoalChange,
  goalNote,
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

      <div className="locked-context__heading">
        <label className="field-label" htmlFor="user-goal">Your goal</label>
        <span className="locked-context__badge">
          {goalEditable ? "Editable goal" : "Recorded goal"}
        </span>
      </div>
      {goalEditable ? (
        <textarea
          id="user-goal"
          className="goal-input"
          value={goal}
          maxLength={2_000}
          disabled={isBusy}
          aria-describedby="goal-note"
          onChange={(event) => onGoalChange(event.currentTarget.value)}
        />
      ) : (
        <p id="user-goal" className="goal-context" data-testid="recorded-goal">
          {goal}
        </p>
      )}
      <p className="field-note" id="goal-note">{goalNote}</p>

      <div className="portal-field">
        <div>
          <span className="field-label">Selected portal</span>
          <code>{portalUrl}</code>
        </div>
        <span className="fictional-badge">Fictional test environment</span>
      </div>
    </section>
  );
}
