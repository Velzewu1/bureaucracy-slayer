import type { DemoAnalysis } from "../types.js";
import {
  factLabel,
  planStatusPresentation,
  routeSteps,
} from "../viewModel.js";

type SafeRoutePanelProps = Readonly<{
  analysis: DemoAnalysis;
}>;

export function SafeRoutePanel({ analysis }: SafeRoutePanelProps) {
  const status = planStatusPresentation(analysis.plan);
  const steps = routeSteps(analysis);

  return (
    <section className="panel route-panel" aria-labelledby="route-heading" aria-live="polite">
      <div className="panel-heading">
        <div>
          <div>
            <p className="eyebrow">Decision</p>
            <h2 id="route-heading">Verified guidance</h2>
          </div>
        </div>
        <span className={`status-badge status-badge--${status.tone}`}>{status.label}</span>
      </div>

      <div className={`decision-summary decision-summary--${status.tone}`}>
        <div className="decision-icon" aria-hidden="true">
          {analysis.plan.status === "ready" ? "✓" : analysis.plan.status === "blocked" ? "×" : "!"}
        </div>
        <div>
          <strong>{status.summary}</strong>
        </div>
      </div>

      {steps.length > 0 ? (
        <div className="route-steps-section">
          <div className="route-section-heading">
            <span>Verified next steps</span>
            <strong>{steps.length}</strong>
          </div>
          <ol className="route-list">
            {steps.map((step) => (
              <li className="route-step" key={step.procedureActionId}>
                <span className="route-step__index">
                  {String(step.index).padStart(2, "0")}
                </span>
                <div className="route-step__body">
                  <div className="route-step__title-row">
                    <div>
                      <span className="step-kind">
                        {step.actionKind.replace("_", " ")}
                      </span>
                      <h3>{step.title}</h3>
                    </div>
                    <span className="confirmation-badge">
                      User confirmation required
                    </span>
                  </div>
                  <p>{step.instruction}</p>
                  {step.observedActionLabel === undefined ? (
                    <div className="observed-action observed-action--human">
                      Human-only task · no browser action
                    </div>
                  ) : (
                    <div className="observed-action">
                      <span>On the website</span>
                      <strong>{step.observedActionLabel}</strong>
                    </div>
                  )}
                  <details className="step-evidence">
                    <summary>View policy evidence ({step.citations.length})</summary>
                    {step.citations.map((citation) => (
                      <blockquote key={`${citation.ruleId}-${citation.pageUrl}`}>
                        “{citation.excerpt}”
                        <footer>
                          <a href={citation.pageUrl} target="_blank" rel="noreferrer">
                            Source
                          </a>
                        </footer>
                      </blockquote>
                    ))}
                  </details>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="route-empty">
          <div aria-hidden="true">⌁</div>
          <h3>No guidance steps are available</h3>
          <p>
            The planner stopped safely. Resolve the reasons below before relying on a route.
          </p>
        </div>
      )}

      {analysis.plan.missingFacts.length > 0 ? (
        <div className="missing-facts-callout">
          <strong>Required information</strong>
          <ul>
            {analysis.plan.missingFacts.map((fact) => (
              <li key={fact}>{factLabel(analysis.model, fact)}</li>
            ))}
          </ul>
        </div>
      ) : null}

    </section>
  );
}
