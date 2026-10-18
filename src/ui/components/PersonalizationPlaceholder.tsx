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
    Readonly<{ heading: string; message: string; support: string }>
  >
> = {
  waiting: {
    heading: "Your situation",
    message: "We'll ask the relevant questions once the website's rules have been verified.",
    support: "Start by analyzing the website.",
  },
  identifying: {
    heading: "Checking the website",
    message: "Relevant questions will appear here when verification finishes.",
    support: "This step does not ask for facts yet.",
  },
  unavailable: {
    heading: "Questions unavailable",
    message: "This run did not produce verified questions. No earlier answers are being shown.",
    support: "Use the header action to try again. Earlier answers are not kept.",
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
      aria-live="polite"
      data-testid="live-personalization-placeholder"
    >
      <div className="panel-heading panel-heading--compact">
        <div>
          <span className="section-number">02</span>
          <div>
            <p className="eyebrow">Questions</p>
            <h2 id="facts-heading">{copy.heading}</h2>
          </div>
        </div>
      </div>

      <div className="situation-empty">
        <p>{copy.message}</p>
        <p className="situation-empty__next">{copy.support}</p>
      </div>
    </section>
  );
}
