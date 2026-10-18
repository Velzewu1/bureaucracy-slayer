import type { DemoAnalysis } from "../types.js";
import { decisionTone, excludedActions } from "../viewModel.js";

type ExcludedActionsPanelProps = Readonly<{
  analysis: DemoAnalysis;
}>;

export function ExcludedActionsPanel({ analysis }: ExcludedActionsPanelProps) {
  const actions = excludedActions(analysis);

  return (
    <section className="panel excluded-panel" aria-labelledby="excluded-heading">
      <div className="panel-heading panel-heading--compact">
        <div>
          <span className="section-number">06</span>
          <div>
            <p className="eyebrow">Routes not taken</p>
            <h2 id="excluded-heading">Blocked &amp; review-required actions</h2>
          </div>
        </div>
        <span className="count-badge">{actions.length}</span>
      </div>

      {actions.length === 0 ? (
        <div className="compact-empty">
          No candidate actions were excluded for the current facts.
        </div>
      ) : (
        <div className="excluded-list">
          {actions.map((action) => (
            <article
              className={`excluded-action excluded-action--${decisionTone(action.status)}`}
              key={action.id}
            >
              <div className="excluded-action__header">
                <div>
                  <span className="decision-status">{action.status}</span>
                  <h3>{action.label}</h3>
                </div>
                <details className="technical-details">
                  <summary>Action identifier</summary>
                  <code>{action.id}</code>
                </details>
              </div>
              <ul>
                {action.reasons.map((reason, index) => (
                  <li key={`${action.id}-${action.reasonCodes[index] ?? String(index)}`}>
                    {reason}
                    {action.reasonCodes[index] === undefined ? null : (
                      <code>{action.reasonCodes[index]}</code>
                    )}
                  </li>
                ))}
              </ul>
              {action.missingFacts.length > 0 ? (
                <p>
                  Missing:{" "}
                  {action.missingFacts.map((fact) => (
                    <code key={fact}>{fact}</code>
                  ))}
                </p>
              ) : null}
              {action.citationRuleIds.length > 0 ? (
                <p>
                  Decision evidence:{" "}
                  {action.citationRuleIds.map((ruleId) => (
                    <code key={ruleId}>{ruleId}</code>
                  ))}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}

      {analysis.plan.warnings.length > 0 ? (
        <div className="planner-warnings">
          <strong>Planner route diagnostics</strong>
          <ul>
            {analysis.plan.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
