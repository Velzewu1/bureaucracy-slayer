import type { DemoAnalysis } from "../types.js";
import { evidenceCards } from "../viewModel.js";

type PolicyEvidencePanelProps = Readonly<{
  analysis: DemoAnalysis;
}>;

const evidenceLabels = {
  verified: "Exact citation verified",
  rejected: "Citation rejected",
  review_required: "Interpretation needs review",
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
          <article className={`evidence-card evidence-card--${card.status}`} key={card.id}>
            <div className="evidence-card__topline">
              <span className={`evidence-status evidence-status--${card.status}`}>
                <span aria-hidden="true">
                  {card.status === "verified" ? "✓" : card.status === "rejected" ? "×" : "!"}
                </span>
                {evidenceLabels[card.status]}
              </span>
              <span className={`rule-effect rule-effect--${card.effect}`}>{card.effect.replace("_", " ")}</span>
            </div>
            <blockquote>“{card.excerpt}”</blockquote>
            {card.status === "rejected" ? (
              <p className="evidence-rejection">
                This excerpt failed deterministic binding and is not treated as verified evidence.
              </p>
            ) : null}
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
          </article>
          ))}
        </div>
      </details>
    </section>
  );
}
