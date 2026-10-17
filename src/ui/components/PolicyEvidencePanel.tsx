import type { DemoAnalysis } from "../types.js";
import { evidenceCards } from "../viewModel.js";

type PolicyEvidencePanelProps = Readonly<{
  analysis: DemoAnalysis;
}>;

const evidenceLabels = {
  verified: "Citation matched",
  citation_mismatch: "Citation mismatch",
  invalid_binding: "Invalid action or reference binding",
  semantic_review: "Semantic review required",
  audit_review: "Semantic review required · qualifier audit",
  valid_unusable: "Rejected rule",
} as const;

export function PolicyEvidencePanel({ analysis }: PolicyEvidencePanelProps) {
  const cards = evidenceCards(analysis);

  return (
    <section className="panel evidence-panel" aria-labelledby="evidence-heading">
      <div className="panel-heading panel-heading--compact">
        <div>
          <span className="section-number">07</span>
          <div>
            <p className="eyebrow">Policy provenance</p>
            <h2 id="evidence-heading">Verified source evidence</h2>
          </div>
        </div>
        <span className={`evidence-result evidence-result--${analysis.evidence.status}`}>
          Evidence set: {analysis.evidence.status}
        </span>
      </div>

      <p className="panel-intro">
        Exact excerpt matching verifies that words appeared in the captured source. It does not
        guarantee that the interpretation is legally or semantically correct.
      </p>

      <details className="full-evidence">
        <summary>Browse all policy evidence ({cards.length})</summary>
        <div className="evidence-list">
          {cards.map((card) => (
            <article
              className={`evidence-card evidence-card--${card.status} evidence-card--effect-${card.effect}`}
              key={card.id}
            >
              <div
                className={`rule-state-line rule-state-line--evidence-card rule-state-line--${card.evidenceState}`}
                aria-label={`${card.effect.toLocaleUpperCase()} · ${card.conditionLabel} · ${card.evidenceLabel}`}
              >
                <span className={`rule-effect rule-effect--${card.effect}`}>
                  {card.effect.replace("_", " ")}
                </span>
                <span aria-hidden="true">·</span>
                <strong className={`condition-state condition-state--${card.conditionState}`}>
                  {card.conditionLabel}
                </strong>
                <span aria-hidden="true">·</span>
                <strong className={`rule-evidence-state rule-evidence-state--${card.evidenceState}`}>
                  {card.evidenceLabel}
                </strong>
              </div>
              <div className="evidence-card__topline evidence-card__classification">
                <span className={`evidence-status evidence-status--${card.status}`}>
                  <span aria-hidden="true">
                    {card.status === "verified"
                      ? "✓"
                      : card.status === "citation_mismatch" || card.status === "invalid_binding"
                        ? "×"
                        : "!"}
                  </span>
                  {evidenceLabels[card.status]}
                </span>
                {card.semanticReviewRequired ? (
                  <span className="semantic-review-label">Semantic review required</span>
                ) : null}
              </div>
              <blockquote>“{card.excerpt}”</blockquote>
              {card.whyUnsafe === undefined ? null : (
                <p className="evidence-rejection">
                  {card.whyUnsafe}
                </p>
              )}
              <dl className="evidence-meta">
                <div>
                  <dt>Rule</dt>
                  <dd>
                    <code>{card.ruleId}</code>
                  </dd>
                </div>
                <div>
                  <dt>Applies when</dt>
                  <dd>{card.condition}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>
                    <a href={card.pageUrl} target="_blank" rel="noreferrer">
                      {card.pageUrl}
                    </a>
                  </dd>
                </div>
                <div>
                  <dt>Binding</dt>
                  <dd>
                    <code>
                      {card.pageId} / {card.blockId}
                    </code>
                  </dd>
                </div>
              </dl>
              {card.issueCodes.length > 0 ? (
                <div className="issue-codes">
                  {card.issueCodes.map((code) => (
                    <span key={code}>{code}</span>
                  ))}
                </div>
              ) : null}
              {card.issues.length > 0 ? (
                <ul className="evidence-issue-list">
                  {card.issues.map((issue, index) => (
                    <li key={`${issue.code}-${index}`}>
                      <code>{issue.code}</code> {issue.message}
                    </li>
                  ))}
                  {card.additionalIssueCount > 0 ? (
                    <li>
                      {card.additionalIssueCount} additional audit finding
                      {card.additionalIssueCount === 1 ? "" : "s"} retained in the recorded bundle.
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </article>
          ))}
        </div>
      </details>
    </section>
  );
}
