import type { DemoAnalysis } from "../types.js";
import { planDifference } from "../viewModel.js";

type PlanComparisonProps = Readonly<{
  original: DemoAnalysis;
  current: DemoAnalysis;
}>;

function displayFact(value: string | number | boolean | undefined): string {
  if (value === undefined) return "unknown";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

export function PlanComparison({ original, current }: PlanComparisonProps) {
  const difference = planDifference(original, current);

  return (
    <section className="panel comparison-panel" aria-labelledby="comparison-heading">
      <div className="panel-heading panel-heading--compact">
        <div>
          <div>
            <p className="eyebrow">After your answer</p>
            <h2 id="comparison-heading">What changed</h2>
          </div>
        </div>
        <span className={`change-badge ${difference.changed ? "change-badge--changed" : ""}`}>
          {difference.changed ? "Route changed" : "No route change"}
        </span>
      </div>

      <div className="comparison-grid">
        <article>
          <span>Original</span>
          <strong>{difference.originalStatus}</strong>
        </article>
        <div className="comparison-arrow" aria-hidden="true">
          →
        </div>
        <article>
          <span>Updated</span>
          <strong>{difference.currentStatus}</strong>
        </article>
      </div>

      <div className="change-cause">
        <span>Precise cause of replan</span>
        {difference.changedFacts.length === 0 ? (
          <strong>No user fact value changed.</strong>
        ) : (
          difference.changedFacts.map((fact) => (
            <strong key={fact.key}>
              {fact.label}: {displayFact(fact.before)} → {displayFact(fact.after)}
            </strong>
          ))
        )}
        <small>
          Selected decision: {difference.decisionBefore} → {difference.decisionAfter}
        </small>
      </div>

      <div className="route-delta">
        <div>
          <span>Removed</span>
          {difference.removedActionDetails.length > 0 ? (
            difference.removedActionDetails.map((action) => (
              <div className="removed-action-detail" key={action.id}>
                <strong>&minus; {action.label}</strong>
                {action.status === undefined ? null : <small>{action.status}</small>}
                {action.reasons.map((reason) => <p key={reason}>{reason}</p>)}
              </div>
            ))
          ) : (
            <em>None</em>
          )}
        </div>
        <div>
          <span>Added</span>
          {difference.addedActions.length > 0 ? (
            difference.addedActions.map((action) => <strong key={action}>+ {action}</strong>)
          ) : (
            <em>None</em>
          )}
        </div>
      </div>

      <div className="immutable-bindings">
        <span className={difference.snapshotUnchanged ? "binding-ok" : "binding-changed"}>
          {difference.snapshotUnchanged ? "✓" : "!"} Snapshot unchanged
        </span>
        <span className={difference.evidenceUnchanged ? "binding-ok" : "binding-changed"}>
          {difference.evidenceUnchanged ? "✓" : "!"} Evidence unchanged
        </span>
        <span className="binding-ok">✓ No Claude call</span>
        <span className="binding-ok">✓ No browser collection</span>
      </div>
    </section>
  );
}
