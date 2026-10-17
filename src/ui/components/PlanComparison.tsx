import type { DemoAnalysis } from "../types.js";
import { planDifference } from "../viewModel.js";

type PlanComparisonProps = Readonly<{
  original: DemoAnalysis;
  current: DemoAnalysis;
}>;

export function PlanComparison({ original, current }: PlanComparisonProps) {
  const difference = planDifference(original, current);

  return (
    <section className="panel comparison-panel" aria-labelledby="comparison-heading">
      <div className="panel-heading panel-heading--compact">
        <div>
          <span className="section-number">06</span>
          <div>
            <p className="eyebrow">Replanning audit</p>
            <h2 id="comparison-heading">Original vs updated route</h2>
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
          <code>{original.plan.id}</code>
          <small>Revision {original.plan.userStateRevision}</small>
        </article>
        <div className="comparison-arrow" aria-hidden="true">
          →
        </div>
        <article>
          <span>Updated</span>
          <strong>{difference.currentStatus}</strong>
          <code>{current.plan.id}</code>
          <small>Revision {current.plan.userStateRevision}</small>
        </article>
      </div>

      <div className="route-delta">
        <div>
          <span>Removed</span>
          {difference.removedActions.length > 0 ? (
            difference.removedActions.map((action) => <strong key={action}>− {action}</strong>)
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
