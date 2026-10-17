import type { JsonScalar } from "../../contracts/index.js";
import type { DemoAnalysis } from "../types.js";
import { readableReason } from "../viewModel.js";

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
  const relevantRules = trace.rules.filter(
    (rule) => rule.applicabilityState !== "inactive",
  );
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
        <span className={`decision-state decision-state--${trace.decision.status}`}>
          {trace.decision.status}
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
        {relevantRules.map((rule) => (
          <article className="trace-rule" key={rule.ruleId}>
            <div>
              <span className={`rule-effect rule-effect--${rule.effect}`}>
                {rule.effect.replace("_", " ")}
              </span>
              <strong>{rule.applicabilityState}</strong>
              <code>{rule.ruleId}</code>
            </div>
            <div className="trace-facts">
              {rule.facts.length === 0 ? (
                <span>Always applies</span>
              ) : (
                rule.facts.map((fact, index) => (
                  <span key={`${rule.ruleId}-${fact.key}-${index}`}>
                    <code>{fact.key}</code> ={" "}
                    <strong>{fact.known ? displayValue(fact.actual) : "unknown"}</strong>
                    {" → "}
                    {fact.truth}
                  </span>
                ))
              )}
            </div>
            {rule.requirement === undefined ? null : (
              <p className="requirement-result">
                Required condition: <strong>{rule.requirement.value}</strong>
              </p>
            )}
            <details>
              <summary>Exact evidence ({rule.citations.length})</summary>
              {rule.citations.map((citation) => (
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
