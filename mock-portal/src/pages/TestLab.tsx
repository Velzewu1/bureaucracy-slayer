import { Card, buttonClass, usePageTitle } from "../components/ui";
import { formatDateTime } from "../domain/format";
import { advanceClock, effectiveStatus, listTransfers } from "../domain/rules";
import { SCENARIOS, getScenario } from "../domain/scenarios";
import { mutate, refreshView, resetScenario, usePortalState } from "../domain/store";

const MIN = 60_000;
const CLOCK_STEPS = [
  { label: "+10 minutes", ms: 10 * MIN },
  { label: "+1 hour", ms: 60 * MIN },
  { label: "+1 day", ms: 24 * 60 * MIN },
  { label: "+7 days", ms: 7 * 24 * 60 * MIN },
  { label: "+30 days", ms: 30 * 24 * 60 * MIN },
] as const;

/**
 * Test harness. It is not part of Northstar Mock Bank, is not linked from any portal page, and
 * reveals ground truth (including the hidden payment method). Do not point an extractor at it.
 */
export function TestLab() {
  usePageTitle("Test lab");
  const state = usePortalState();
  const scenario = getScenario(state.scenarioId);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Test lab</h1>
        <p className="text-slate-600">
          Harness controls for the simulation. This page is not part of the bank site and shows ground truth.
        </p>
      </header>

      <Card>
        <h2 className="text-lg font-semibold">Current scenario</h2>
        <p className="mt-1 font-medium" data-testid="lab-scenario">{scenario.id}</p>
        <p className="text-sm text-slate-600">{scenario.summary}</p>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-slate-500">Edition</dt>
            <dd data-testid="lab-edition">{scenario.edition}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Portal time</dt>
            <dd data-testid="lab-time">{formatDateTime(state.nowMs)}</dd>
          </div>
          {listTransfers(state).map((transfer) => (
            <div key={transfer.id} className="sm:col-span-2">
              <dt className="text-slate-500">{transfer.id}: true method / effective status</dt>
              <dd data-testid="lab-transfer">
                {transfer.method} / {effectiveStatus(transfer, state.nowMs)}
              </dd>
            </div>
          ))}
          <div>
            <dt className="text-slate-500">Support cases</dt>
            <dd data-testid="lab-cases">{state.cases.map((c) => c.id).join(", ") || "none"}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold">Advance the simulated clock</h2>
        <p className="mt-1 text-sm text-slate-600">
          Open transfer pages in other tabs keep showing their old status until they reload or act.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {CLOCK_STEPS.map((step) => (
            <button
              key={step.label}
              type="button"
              className={buttonClass.secondary}
              onClick={() => mutate((current) => advanceClock(current, step.ms), (next) => next)}
            >
              {step.label}
            </button>
          ))}
          <button type="button" className={buttonClass.secondary} onClick={refreshView}>
            Refresh this tab's view
          </button>
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold">Load a scenario</h2>
        <p className="mt-1 text-sm text-slate-600">
          Loading resets the clock, cancellations and support cases. Any page also accepts{" "}
          <code>?scenario=&lt;id&gt;</code>.
        </p>
        <ul className="mt-3 divide-y divide-slate-100">
          {SCENARIOS.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-4 py-3">
              <div>
                <p className="font-medium">{item.title}</p>
                <p className="text-sm text-slate-600">{item.summary}</p>
                <p className="text-xs text-slate-400">{item.id}</p>
              </div>
              <button
                type="button"
                className={buttonClass.primary}
                data-testid={`load-${item.id}`}
                onClick={() => resetScenario(item.id)}
              >
                Load
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
