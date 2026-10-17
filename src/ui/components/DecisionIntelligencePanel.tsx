import type { JsonScalar } from "../../contracts/index.js";
import type { DemoAnalysis } from "../types.js";
import {
  actionReadinessPresentation,
  policyRulePresentations,
  readableReason,
} from "../viewModel.js";

type DecisionIntelligencePanelProps = Readonly<{
  analysis: DemoAnalysis;
}>;

function displayValue(value: JsonScalar | readonly JsonScalar[] | undefined): string {
  if (value === undefined) return "unknown";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

export function DecisionIntelligencePanel({
  analysis,
}: DecisionIntelligencePanelProps) {
  const intelligence = analysis.decisionIntelligence;
  const trace = intelligence.trace;
  const actionState = actionReadinessPresentation(trace.decision.status);
  const rules = policyRulePresentations(analysis).filter(
    (rule) => rule.actionId === trace.actionId,
  );
  const hasSemanticReview = rules.some((rule) => rule.semanticReviewRequired);
  const materialCounterfactuals = intelligence.counterfactuals
    .filter((counterfactual) => counterfactual.changed)
    .slice(0, 4);

  return (
    <section
      className="panel intelligence-panel"
      aria-labelledby="intelligence-heading"
    >
      <div className="panel-heading panel-heading--compact">
        <div>
          <span className="section-number">04</span>
          <div>
            <p className="eyebrow">Inspectable reasoning</p>
            <h2 id="intelligence-heading">Why this decision?</h2>
          </div>
        </div>
        <span
          className={`decision-state decision-state--${trace.decision.status}`}
          aria-label="Authoritative action state"
          data-testid="authoritative-action-state"
        >
          {actionState.label}
        </span>
      </div>

      <div className="why-summary">
        <div>
          <span>Selected action</span>
          <strong>{trace.actionLabel}</strong>
          <code>{trace.actionId}</code>
        </div>
        <p>
          {trace.decision.reasonCodes.map(readableReason).join(" ")}
          {trace.planReasonCodes.length === 0
            ? null
            : ` Route result: ${trace.planReasonCodes
                .map(readableReason)
                .join(" ")}`}
        </p>
      </div>

      {hasSemanticReview ? (
        <div className="review-boundary" data-testid="semantic-review-boundary">
          <strong>Semantic review required.</strong>
          <p>
            Fact changes and bounded what-if checks cannot make a rejected permission usable.
            The evaluator and planner continue to withhold the affected action.
          </p>
        </div>
      ) : null}

      {intelligence.nextQuestion === undefined ? null : (
        <div className="next-question" data-testid="next-question">
          <span>Highest-priority next question</span>
          <strong>{intelligence.nextQuestion.label}?</strong>
          <p>{intelligence.nextQuestion.whyItMatters}</p>
          <div>
            {intelligence.nextQuestion.alternatives.map((alternative) => (
              <span key={String(alternative.value)}>
                {displayValue(alternative.value)} → {alternative.planStatus} · selected{" "}
                {alternative.actionDecision}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="trace-rule-list">
        {rules.map((rule) => (
          <article
            className={`trace-rule trace-rule--condition-${rule.applicability} trace-rule--evidence-${rule.evidenceState}`}
            key={rule.ruleId}
          >
            <div
              className="rule-state-line"
              aria-label={`${rule.effect.toLocaleUpperCase()} · ${rule.conditionLabel} · ${rule.evidenceLabel}`}
            >
              <span className={`rule-effect rule-effect--${rule.effect}`}>
                {rule.effect.replace("_", " ")}
              </span>
              <span aria-hidden="true">·</span>
              <strong className={`condition-state condition-state--${rule.applicability}`}>
                {rule.conditionLabel}
              </strong>
              <span aria-hidden="true">·</span>
              <strong className={`rule-evidence-state rule-evidence-state--${rule.evidenceState}`}>
                {rule.evidenceLabel}
              </strong>
              <code>{rule.ruleId}</code>
            </div>
            <div className="trace-facts">
              {rule.trace.facts.length === 0 ? (
                <span>Always applies</span>
              ) : (
                rule.trace.facts.map((fact, index) => (
                  <span key={`${rule.ruleId}-${fact.key}-${index}`}>
                    <code>{fact.key}</code> ={" "}
                    <strong>{fact.known ? displayValue(fact.actual) : "unknown"}</strong>
                    {" → "}
                    {fact.truth}
                  </span>
                ))
              )}
            </div>
            {rule.trace.requirement === undefined ? null : (
              <p className="requirement-result">
                Required condition: <strong>{rule.trace.requirement.value}</strong>
              </p>
            )}
            {rule.semanticReviewRequired ? (
              <p className="semantic-review-label">Semantic review required</p>
            ) : null}
            {rule.rejectionReasons.length === 0 ? null : (
              <ul className="rule-rejection-reasons">
                {rule.rejectionReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            <details>
              <summary>Exact evidence ({rule.trace.citations.length})</summary>
              {rule.trace.citations.map((citation) => (
                <blockquote key={`${rule.ruleId}-${citation.blockId}`}>
                  “{citation.excerpt}”
                  <footer>
                    <code>
                      {citation.pageId} / {citation.blockId}
                    </code>
                    <a href={citation.pageUrl} target="_blank" rel="noreferrer">
                      Source
                    </a>
                  </footer>
                </blockquote>
              ))}
            </details>
          </article>
        ))}
      </div>

      {materialCounterfactuals.length === 0 ? null : (
        <details className="counterfactuals">
          <summary>Explore bounded what-if results ({materialCounterfactuals.length})</summary>
          <div className="counterfactual-list">
            {materialCounterfactuals.map((counterfactual) => (
              <article
                key={`${counterfactual.factKey}-${String(
                  counterfactual.hypotheticalValue,
                )}`}
              >
                <span>If {counterfactual.factLabel} were</span>
                <strong>{displayValue(counterfactual.hypotheticalValue)}</strong>
                <p>
                  Decision: {counterfactual.decisionBefore} →{" "}
                  {counterfactual.decisionAfter}. Route:{" "}
                  {counterfactual.planStatusBefore} → {counterfactual.planStatusAfter}.
                </p>
                {counterfactual.unresolvedFacts.length === 0 ? (
                  <small>No unresolved facts remain for the selected route.</small>
                ) : (
                  <small>
                    Still unresolved: {counterfactual.unresolvedFacts.join(", ")}
                  </small>
                )}
                <small className="counterfactual-evidence-note">
                  Evidence admissibility is unchanged
                  {hasSemanticReview ? "; semantic review is still required." : "."}
                </small>
              </article>
            ))}
          </div>
        </details>
      )}

      <p className="computation-note">
        {intelligence.computationCount} bounded deterministic what-if evaluations; actual
        user facts were not changed.
      </p>
    </section>
  );
}
