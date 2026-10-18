import type { DemoAnalysis } from "../types.js";
import {
  actionReadinessPresentation,
  decisionTone,
  excludedActions,
  factLabel,
} from "../viewModel.js";

type ExcludedActionsPanelProps = Readonly<{
  analysis: DemoAnalysis;
}>;

export function ExcludedActionsPanel({ analysis }: ExcludedActionsPanelProps) {
  const actions = excludedActions(analysis);

  return (
    <section className="panel excluded-panel" aria-labelledby="excluded-heading">
      <div className="panel-heading panel-heading--compact">
        <div>
          <div>
            <p className="eyebrow">Other actions</p>
            <h2 id="excluded-heading">Not available from this decision</h2>
          </div>
        </div>
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
                  <span className="decision-status">
                    {actionReadinessPresentation(action.status, action.reasonCodes).label}
                  </span>
                  <h3>{action.label}</h3>
                </div>
              </div>
              <ul>
                {action.reasons.map((reason) => (
                  <li key={`${action.id}-${reason}`}>{reason}</li>
                ))}
              </ul>
              {action.missingFacts.length > 0 ? (
                <p>
                  Still needed:{" "}
                  {action.missingFacts
                    .map((fact) => factLabel(analysis.model, fact))
                    .join(", ")}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      )}

    </section>
  );
}
