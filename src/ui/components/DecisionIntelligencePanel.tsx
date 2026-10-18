import type { JsonScalar } from "../../contracts/index.js";
import type { DemoAnalysis } from "../types.js";
import {
  actionReadinessPresentation,
  factLabel,
  formatFactInfluence,
  isDecisiveRule,
  planStatusPresentation,
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

function RuleExplanation({
  analysis,
  rule,
  repeatedReasons,
}: Readonly<{
  analysis: DemoAnalysis;
  rule: ReturnType<typeof policyRulePresentations>[number];
  repeatedReasons: readonly string[];
}>) {
  const uniqueReasons = rule.rejectionReasons.filter(
    (reason) => !repeatedReasons.includes(reason),
  );
  return (
    <article
      className={`trace-rule trace-rule--condition-${rule.applicability} trace-rule--evidence-${rule.evidenceState}`}
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
      </div>
      <div className="trace-facts">
        {rule.trace.facts.length === 0 ? (
          <span>Always applies</span>
        ) : (
          rule.trace.facts.map((fact, index) => (
            <span key={`${rule.ruleId}-${fact.key}-${index}`}>
              {formatFactInfluence(analysis.model, fact)}
            </span>
          ))
        )}
      </div>
      {rule.trace.requirement === undefined ? null : (
        <p className="requirement-result">
          Required condition: <strong>{rule.trace.requirement.value}</strong>
        </p>
      )}
      {uniqueReasons.length === 0 ? null : (
        <ul className="rule-rejection-reasons">
          {uniqueReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <details>
        <summary>View policy evidence ({rule.trace.citations.length})</summary>
        {rule.trace.citations.map((citation) => (
          <blockquote key={`${rule.ruleId}-${citation.blockId}`}>
            “{citation.excerpt}”
            <footer>
              <a href={citation.pageUrl} target="_blank" rel="noreferrer">
                Source
              </a>
            </footer>
          </blockquote>
        ))}
      </details>
    </article>
  );
}

export function DecisionIntelligencePanel({
  analysis,
}: DecisionIntelligencePanelProps) {
  const intelligence = analysis.decisionIntelligence;
  const trace = intelligence.trace;
  const actionState = actionReadinessPresentation(
    trace.decision.status,
    trace.decision.reasonCodes,
  );
  const rules = policyRulePresentations(analysis).filter(
    (rule) => rule.actionId === trace.actionId,
  );
  const decisiveRules = rules.filter(isDecisiveRule);
  const otherRules = rules.filter((rule) => !isDecisiveRule(rule));
  const hasSemanticReview = rules.some((rule) => rule.semanticReviewRequired);
  const reviewReasons = [
    ...new Set(rules.flatMap((rule) => rule.rejectionReasons)),
  ];
  const decisionReasons = trace.decision.reasonCodes.map(readableReason);
  const extraRouteReasons = trace.planReasonCodes
    .map(readableReason)
    .filter((reason) => !decisionReasons.includes(reason));
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
          <div>
            <p className="eyebrow">Reasoning</p>
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
        </div>
        <p>
          {decisionReasons.join(" ")}
          {extraRouteReasons.length === 0
            ? null
            : ` Route result: ${extraRouteReasons.join(" ")}`}
        </p>
      </div>

      {hasSemanticReview ? (
        <div className="review-boundary" data-testid="semantic-review-boundary">
          <strong>Human review required.</strong>
          <p>
            A cited permission was not accepted as usable evidence. Answering more questions
            cannot repair that evidence limitation, and this is not a verified route.
          </p>
          {reviewReasons.length === 0 ? null : (
            <ul className="rule-rejection-reasons">
              {reviewReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
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
                {displayValue(alternative.value)} →{" "}
                {planStatusPresentation({ status: alternative.planStatus }).label}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="trace-rule-list">
        {decisiveRules.map((rule) => (
          <RuleExplanation
            analysis={analysis}
            key={rule.ruleId}
            repeatedReasons={hasSemanticReview ? reviewReasons : []}
            rule={rule}
          />
        ))}
        {otherRules.length === 0 ? null : (
          <details className="other-rules" data-testid="nondecisive-rules">
            <summary>Other rules that do not decide this result ({otherRules.length})</summary>
            {otherRules.map((rule) => (
              <RuleExplanation
                analysis={analysis}
                key={rule.ruleId}
                repeatedReasons={hasSemanticReview ? reviewReasons : []}
                rule={rule}
              />
            ))}
          </details>
        )}
      </div>

      {materialCounterfactuals.length === 0 ? null : (
        <details className="counterfactuals">
          <summary>What changes if…? ({materialCounterfactuals.length})</summary>
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
                  {actionReadinessPresentation(counterfactual.decisionBefore).label} →{" "}
                  {actionReadinessPresentation(counterfactual.decisionAfter).label}. Route:{" "}
                  {planStatusPresentation({ status: counterfactual.planStatusBefore }).label}{" "}
                  → {planStatusPresentation({ status: counterfactual.planStatusAfter }).label}.
                </p>
                {counterfactual.unresolvedFacts.length === 0 ? null : (
                  <small>
                    Still needed:{" "}
                    {counterfactual.unresolvedFacts
                      .map((fact) => factLabel(analysis.model, fact))
                      .join(", ")}
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

    </section>
  );
}
