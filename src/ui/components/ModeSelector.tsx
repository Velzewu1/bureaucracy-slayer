import type { DemoMode } from "../types.js";

type ModeSelectorProps = Readonly<{
  mode: DemoMode;
  disabled: boolean;
  onChange: (mode: DemoMode) => void;
}>;

const modes: readonly Readonly<{ id: DemoMode; label: string; detail: string }>[] = [
  {
    id: "verified_fixture",
    label: "Verified fixture",
    detail: "Hand-checked model with four demo scenarios",
  },
  {
    id: "recorded_sonnet",
    label: "Recorded Sonnet extraction",
    detail: "Previously extracted model with uncertainty preserved",
  },
];

export function ModeSelector({ mode, disabled, onChange }: ModeSelectorProps) {
  return (
    <fieldset className="mode-selector" disabled={disabled} aria-label="Demo mode">
      {modes.map((candidate) => (
        <label
          className={candidate.id === mode ? "mode-selector__option mode-selector__option--active" : "mode-selector__option"}
          key={candidate.id}
        >
          <input
            type="radio"
            name="demo-mode"
            value={candidate.id}
            checked={candidate.id === mode}
            onChange={() => onChange(candidate.id)}
          />
          <span>
            <strong>{candidate.label}</strong>
            <small>{candidate.detail}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
