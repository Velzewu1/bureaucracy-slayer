import type {
  JsonScalar,
  ProcedureModel,
  UserState,
} from "../../contracts/index.js";

type UserStatePanelProps = Readonly<{
  model: ProcedureModel;
  userState: UserState;
  missingFacts: readonly string[];
  isDirty: boolean;
  isBusy: boolean;
  onFactChange: (key: string, value: JsonScalar | undefined) => void;
  onReplan: () => void;
}>;

function controlValue(value: JsonScalar | undefined): string {
  return value === undefined ? "" : String(value);
}

function parseSelection(
  definition: ProcedureModel["factDefinitions"][number],
  rawValue: string,
): JsonScalar | undefined {
  if (rawValue === "") return undefined;
  if (definition.type === "boolean") return rawValue === "true";
  if (definition.type === "number") return Number(rawValue);
  return rawValue;
}

export function UserStatePanel({
  model,
  userState,
  missingFacts,
  isDirty,
  isBusy,
  onFactChange,
  onReplan,
}: UserStatePanelProps) {
  return (
    <section className="panel facts-panel" aria-labelledby="facts-heading">
      <div className="panel-heading panel-heading--compact">
        <div>
          <span className="section-number">02</span>
          <div>
            <p className="eyebrow">Personalize the decision</p>
            <h2 id="facts-heading">Your facts</h2>
          </div>
        </div>
        <span className="revision-label">Revision {userState.revision}</span>
      </div>

      <p className="panel-intro">
        Only facts declared by the extracted procedure model appear here. Unanswered means unknown.
      </p>

      <div className="fact-list">
        {model.factDefinitions.map((definition) => {
          const value = userState.facts[definition.key];
          const isMissing = missingFacts.includes(definition.key);
          const options =
            definition.allowedValues ??
            (definition.type === "boolean" ? ([true, false] as const) : undefined);

          return (
            <div className={`fact-field ${isMissing ? "fact-field--missing" : ""}`} key={definition.key}>
              <label htmlFor={`fact-${definition.key}`}>
                <span>{definition.label}</span>
                <code>{definition.key}</code>
              </label>
              {options === undefined ? (
                <input
                  id={`fact-${definition.key}`}
                  type={definition.type === "number" ? "number" : "text"}
                  value={controlValue(value)}
                  onChange={(event) =>
                    onFactChange(
                      definition.key,
                      parseSelection(definition, event.currentTarget.value),
                    )
                  }
                  disabled={isBusy}
                  placeholder="Unknown"
                />
              ) : (
                <select
                  id={`fact-${definition.key}`}
                  value={controlValue(value)}
                  onChange={(event) =>
                    onFactChange(
                      definition.key,
                      parseSelection(definition, event.currentTarget.value),
                    )
                  }
                  disabled={isBusy}
                >
                  <option value="">Unknown / not answered</option>
                  {options.map((option) => (
                    <option value={String(option)} key={`${definition.key}-${String(option)}`}>
                      {typeof option === "boolean"
                        ? option
                          ? "Yes"
                          : "No"
                        : String(option).replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              )}
              {isMissing ? <span className="field-message">Required to evaluate a possible route</span> : null}
            </div>
          );
        })}
      </div>

      <button
        className="button button--secondary button--full"
        type="button"
        onClick={onReplan}
        disabled={!isDirty || isBusy}
      >
        {isBusy ? "Replanning…" : "Replan with updated facts"}
      </button>
      <p className="deterministic-note">
        <span aria-hidden="true">↻</span>
        Replanning calls only the deterministic evaluator and planner—no Claude or browser collection.
      </p>
    </section>
  );
}
