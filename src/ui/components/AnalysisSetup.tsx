type AnalysisSetupProps = Readonly<{
  goal: string;
  portalUrl: string;
  isBusy: boolean;
  hasAnalysis: boolean;
  goalNote: string;
}>;

export function AnalysisSetup({
  goal,
  portalUrl,
  isBusy,
  hasAnalysis,
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
        <span className="field-label" id="locked-goal-label">Your goal</span>
        <span className="locked-context__badge">Locked demo goal</span>
      </div>
      <p
        aria-labelledby="locked-goal-label"
        className="goal-context"
        data-testid="locked-goal"
      >
        {goal}
      </p>
      <p className="field-note">{goalNote}</p>

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
