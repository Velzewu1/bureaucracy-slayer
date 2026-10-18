import type { LiveExtractionPhase } from "../types.js";

type LiveProgressPanelProps = Readonly<{
  phase: LiveExtractionPhase;
  onStop: () => void;
}>;

type ConceptualStage = Readonly<{
  label: string;
  firstPhase: LiveExtractionPhase;
}>;

const phaseOrder: Readonly<Record<LiveExtractionPhase, number>> = {
  queued: 0,
  collecting: 1,
  selecting_sources: 2,
  extracting_policy: 3,
  mapping_procedure: 3,
  validating: 4,
  complete: 5,
  failed: 0,
};

const stages: readonly ConceptualStage[] = [
  { label: "Collecting website evidence", firstPhase: "collecting" },
  { label: "Selecting relevant source material", firstPhase: "selecting_sources" },
  { label: "Extracting policies and procedures", firstPhase: "extracting_policy" },
  { label: "Validating evidence", firstPhase: "validating" },
  { label: "Preparing the decision", firstPhase: "complete" },
];

export function liveProgressTitle(phase: LiveExtractionPhase): string {
  switch (phase) {
    case "queued":
      return "Waiting to start the live analysis…";
    case "collecting":
      return "Collecting website evidence…";
    case "selecting_sources":
      return "Selecting relevant source material…";
    case "extracting_policy":
    case "mapping_procedure":
      return "Extracting policies and procedures…";
    case "validating":
      return "Validating evidence…";
    case "complete":
      return "Preparing the decision…";
    case "failed":
      return "Live extraction failed operationally.";
  }
}

export function liveStageState(
  phase: LiveExtractionPhase,
  stage: ConceptualStage,
): "complete" | "current" | "pending" {
  const current = phaseOrder[phase];
  const first = phaseOrder[stage.firstPhase];
  if (current > first) return "complete";
  if (current === first && phase !== "queued" && phase !== "failed") return "current";
  return "pending";
}

export function LiveProgressPanel({ phase, onStop }: LiveProgressPanelProps) {
  return (
    <section className="panel progress-panel" aria-live="polite">
      <div className="progress-track" aria-hidden="true">
        <span />
      </div>
      <p className="eyebrow">Live analysis in progress</p>
      <h2>{liveProgressTitle(phase)}</h2>
      <p>
        Progress follows confirmed backend phases. No completion estimate is available.
      </p>

      <ol className="live-stage-list" aria-label="Live analysis stages">
        {stages.map((stage, index) => {
          const state = liveStageState(phase, stage);
          return (
            <li
              className={`live-stage live-stage--${state}`}
              aria-current={state === "current" ? "step" : undefined}
              key={stage.label}
            >
              <span className="live-stage__marker" aria-hidden="true">
                {state === "complete" ? "✓" : index + 1}
              </span>
              <span>{stage.label}</span>
              <small>{state === "complete" ? "Complete" : state === "current" ? "In progress" : "Waiting"}</small>
            </li>
          );
        })}
      </ol>

      <button className="button button--secondary" type="button" onClick={onStop}>
        Stop watching
      </button>
    </section>
  );
}
