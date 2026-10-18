import type { DemoAnalysis } from "../types.js";
import {
  planStatusPresentation,
  readableReason,
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
          <span className="section-number">03</span>
          <div>
            <p className="eyebrow">Decision status</p>
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
          <details className="technical-details">
            <summary>Plan reference</summary>
            <p>
              Plan <code>{analysis.plan.id}</code> · User state revision{" "}
              {analysis.plan.userStateRevision}
            </p>
          </details>
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
                      <span>Observed {step.observedActionKind}</span>
                      <strong>{step.observedActionLabel}</strong>
                      <code>{step.websiteActionId}</code>
                    </div>
                  )}
                  <details className="step-evidence">
                    <summary>
                      View supporting evidence ({step.citations.length})
                    </summary>
                    {step.citations.map((citation) => (
                      <blockquote key={`${citation.ruleId}-${citation.pageUrl}`}>
                        “{citation.excerpt}”
                        <footer>
                          <code>{citation.ruleId}</code>
                          <a href={citation.pageUrl} target="_blank" rel="noreferrer">
                            {citation.pageUrl}
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
              <li key={fact}>
                <code>{fact}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {analysis.plan.reasonCodes.length > 0 ? (
        <div className="reason-strip">
          {analysis.plan.reasonCodes.map((code) => (
            <span title={readableReason(code)} key={code}>
              {code}
            </span>
          ))}
        </div>
      ) : null}

      <div className="guidance-warning">
        <strong>Guidance only.</strong> Nothing here can submit, cancel, recover, or otherwise execute a
        financial action.
      </div>
    </section>
  );
}
