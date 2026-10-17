import type { PersonalizationView } from "../guidedPersonalization.js";

type PersonalizationViewToggleProps = Readonly<{
  view: PersonalizationView;
  guidedAvailable: boolean;
  disabled: boolean;
  onChange: (view: PersonalizationView) => void;
}>;

export function PersonalizationViewToggle({
  view,
  guidedAvailable,
  disabled,
  onChange,
}: PersonalizationViewToggleProps) {
  return (
    <div className="personalization-view-toggle" aria-label="Personalization view">
      <button
        type="button"
        className={view === "guided" ? "is-active" : ""}
        aria-pressed={view === "guided"}
        disabled={disabled || !guidedAvailable}
        onClick={() => onChange("guided")}
      >
        Guided
      </button>
      <button
        type="button"
        className={view === "all_facts" ? "is-active" : ""}
        aria-pressed={view === "all_facts"}
        disabled={disabled}
        onClick={() => onChange("all_facts")}
      >
        All facts
      </button>
    </div>
  );
}
