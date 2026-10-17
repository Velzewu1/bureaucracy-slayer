import { useEffect, useState } from "react";

import type { JsonScalar, ProcedureModel, UserState } from "../../contracts/index.js";
import {
  factOptions,
  guidedDecisionPresentation,
  questionCitations,
  selectGuidedQuestion,
} from "../guidedPersonalization.js";
import type { DemoAnalysis } from "../types.js";

type GuidedPersonalizationProps = Readonly<{
  analysis: DemoAnalysis;
  userState: UserState;
  isBusy: boolean;
  onAnswer: (key: string, value: JsonScalar | undefined) => void;
}>;

function displayValue(value: JsonScalar): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value).replaceAll("_", " ");
}

function QuestionControl({
  definition,
  isBusy,
  onAnswer,
}: Readonly<{
  definition: ProcedureModel["factDefinitions"][number];
  isBusy: boolean;
  onAnswer: (value: JsonScalar | undefined) => void;
}>) {
  const [draft, setDraft] = useState("");
  const options = factOptions(definition);

  useEffect(() => setDraft(""), [definition.key]);

  if (options !== undefined) {
    return (
      <div className="guided-options" role="group" aria-label={definition.label}>
        {options.map((option) => (
          <button
            type="button"
            className="guided-option"
            disabled={isBusy}
            key={`${definition.key}-${String(option)}`}
            onClick={() => onAnswer(option)}
          >
            {displayValue(option)}
          </button>
        ))}
        <button
          type="button"
          className="guided-option guided-option--unknown"
          disabled={isBusy}
          onClick={() => onAnswer(undefined)}
        >
          I&apos;m not sure
        </button>
      </div>
    );
  }

  return (
    <form
      className="guided-input"
      onSubmit={(event) => {
        event.preventDefault();
        if (draft === "") return;
        onAnswer(definition.type === "number" ? Number(draft) : draft);
      }}
    >
      <label htmlFor={`guided-${definition.key}`}>Your answer</label>
      <input
        id={`guided-${definition.key}`}
        type={definition.type === "number" ? "number" : "text"}
        value={draft}
        disabled={isBusy}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
      <div>
        <button className="button button--secondary" type="submit" disabled={isBusy || draft === ""}>
          Use this answer
        </button>
        <button className="button button--quiet" type="button" disabled={isBusy} onClick={() => onAnswer(undefined)}>
          I&apos;m not sure
        </button>
      </div>
    </form>
  );
}

export function GuidedPersonalization({
  analysis,
  userState,
  isBusy,
  onAnswer,
}: GuidedPersonalizationProps) {
  const [editingFactKey, setEditingFactKey] = useState<string>();
  const question = selectGuidedQuestion(analysis, editingFactKey, userState);
  const decision = guidedDecisionPresentation(analysis);
  const citations =
    question === undefined ? [] : questionCitations(analysis, question.definition.key);
  const answeredFacts = analysis.model.factDefinitions.filter(
    (definition) => userState.facts[definition.key] !== undefined,
  );

  useEffect(() => {
    if (
      editingFactKey !== undefined &&
      !analysis.model.factDefinitions.some((definition) => definition.key === editingFactKey)
    ) {
      setEditingFactKey(undefined);
    }
  }, [analysis.model, editingFactKey]);

  function answer(value: JsonScalar | undefined): void {
    if (question === undefined) return;
    setEditingFactKey(undefined);
    onAnswer(question.definition.key, value);
  }

  return (
    <section className="panel facts-panel guided-panel" aria-labelledby="guided-heading">
      <div className="panel-heading panel-heading--compact">
        <div>
          <span className="section-number">02</span>
          <div>
            <p className="eyebrow">Guided personalization</p>
            <h2 id="guided-heading">One relevant question at a time</h2>
          </div>
        </div>
        <span className="revision-label">Revision {userState.revision}</span>
      </div>

      <div className={`guided-status guided-status--${decision.tone}`} aria-live="polite">
        <strong>{decision.label}</strong>
        <span>{decision.summary}</span>
      </div>

      {question === undefined ? (
        <div className="guided-empty" data-testid="guided-no-question">
          <strong>No additional verified question is currently required.</strong>
          <p>
            This does not itself grant permission. The decision and verified route remain authoritative.
          </p>
        </div>
      ) : (
        <div className="guided-question" data-testid="guided-question">
          <span className="guided-question__source">
            {question.source === "adaptive"
              ? "Highest-priority verified question"
              : question.source === "editing"
                ? "Change an earlier answer"
                : "Next unresolved fact (canonical order)"}
          </span>
          <h3>{question.definition.label}</h3>
          <code>{question.definition.key}</code>
          <QuestionControl
            key={question.definition.key}
            definition={question.definition}
            isBusy={isBusy}
            onAnswer={answer}
          />
          <div className="why-asking">
            <strong>Why we&apos;re asking</strong>
            <p>
              {question.adaptiveQuestion?.whyItMatters ??
                (question.source === "editing"
                  ? "This canonical fact appears in the verified conditions used for the current decision."
                  : "This canonical fact is unresolved in the current verified decision.")}
            </p>
            {citations.length === 0 ? null : (
              <details>
                <summary>Policy sources related to this question ({citations.length})</summary>
                {citations.map((citation) => (
                  <blockquote key={`${citation.ruleId}-${citation.blockId}`}>
                    &ldquo;{citation.excerpt}&rdquo;
                    <footer>
                      <code>{citation.ruleId}</code>
                      <a href={citation.pageUrl} target="_blank" rel="noreferrer">Source</a>
                    </footer>
                  </blockquote>
                ))}
              </details>
            )}
          </div>
        </div>
      )}

      {answeredFacts.length === 0 ? null : (
        <details className="guided-answers">
          <summary>Review or change earlier answers ({answeredFacts.length})</summary>
          <div>
            {answeredFacts.map((definition) => {
              const value = userState.facts[definition.key];
              if (value === undefined) return null;
              return (
                <div key={definition.key}>
                  <span>{definition.label}</span>
                  <strong>{displayValue(value)}</strong>
                  <button type="button" disabled={isBusy} onClick={() => setEditingFactKey(definition.key)}>
                    Change
                  </button>
                </div>
              );
            })}
          </div>
        </details>
      )}

      <p className="deterministic-note">
        <span aria-hidden="true">&#8635;</span>
        Each answer replans with the deterministic evaluator and planner only. No extraction runs.
      </p>
    </section>
  );
}
