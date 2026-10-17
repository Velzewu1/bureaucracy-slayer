export type PersonalizationPlaceholderState =
  | "waiting"
  | "identifying"
  | "unavailable";

type PersonalizationPlaceholderProps = Readonly<{
  state: PersonalizationPlaceholderState;
}>;

const presentation: Readonly<
  Record<
    PersonalizationPlaceholderState,
    Readonly<{ label: string; message: string }>
  >
> = {
  waiting: {
    label: "Questions pending verification",
    message:
      "Relevant questions will appear after the website policies have been extracted and verified.",
  },
  identifying: {
    label: "Identifying relevant questions",
    message: "Identifying which facts matter for your situation…",
  },
  unavailable: {
    label: "Personalization unavailable",
    message:
      "Verified questions are unavailable for this run. No facts or guidance from an earlier Live result are being shown.",
  },
};

export function PersonalizationPlaceholder({
  state,
}: PersonalizationPlaceholderProps) {
  const copy = presentation[state];

  return (
    <section
      className={`panel facts-panel facts-panel--placeholder facts-panel--${state}`}
      aria-labelledby="facts-heading"
      aria-disabled="true"
      aria-live="polite"
      data-testid="live-personalization-placeholder"
    >
      <div className="panel-heading panel-heading--compact">
        <div>
          <span className="section-number">02</span>
          <div>
            <p className="eyebrow">Personalize the decision</p>
            <h2 id="facts-heading">{copy.label}</h2>
          </div>
        </div>
        <span className="revision-label">Not available yet</span>
      </div>

      <p className="panel-intro">{copy.message}</p>

      <div className="personalization-placeholder" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>

      <div className="personalization-safety-note">
        <span aria-hidden="true">—</span>
        Questions remain disabled until their canonical definitions pass verification.
      </div>
    </section>
  );
}
