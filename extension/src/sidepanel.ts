import { viewFingerprint, type GuidanceView, type StepView } from "./guidance.js";
import type { ActionOutcome, PanelCommand, PanelResponse } from "./messages.js";

/**
 * Side panel presentation. It renders only the view model prepared by the
 * background worker, builds DOM with textContent only (no HTML string injection), and sends
 * commands that name step indexes only.
 */

const root = document.getElementById("slayer-panel");
let feedback: Readonly<{ text: string; warn: boolean }> | undefined;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: Readonly<{ className?: string; text?: string }> = {},
  children: readonly (Node | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className !== undefined) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const child of children) if (child !== undefined) node.append(child);
  return node;
}

async function send(command: PanelCommand): Promise<PanelResponse> {
  return (await chrome.runtime.sendMessage(command)) as PanelResponse;
}

function describeOutcome(outcome: ActionOutcome, detail: string | undefined): typeof feedback {
  switch (outcome) {
    case "none":
      return undefined;
    case "opened":
      return { text: "Opened the page in your Northstar tab. Nothing was clicked for you.", warn: false };
    case "highlighted":
      return { text: "Highlighted on the page. Nothing was clicked; do it yourself when you are ready.", warn: false };
    case "find_manually":
      return {
        text:
          detail === "AMBIGUOUS"
            ? "Find this step manually. More than one similar control matched, so nothing was highlighted."
            : "Find this step manually. The control could not be matched safely.",
        warn: true,
      };
    case "denied":
      return { text: "Not allowed for the current guidance, so nothing was done.", warn: true };
    case "rejected_fixture":
      return {
        text:
          detail === "REPLAYED_SEQUENCE"
            ? "Rejected: this is an older analysis than the one already accepted for this session."
            : "Rejected: the fixture failed validation.",
        warn: true,
      };
    case "no_portal_tab":
      return { text: "Open Northstar Mock Bank in a tab first.", warn: true };
  }
}

function minutes(ms: number | undefined): string {
  if (ms === undefined) return "";
  return `Valid for about ${Math.max(1, Math.ceil(ms / 60000))} more min.`;
}

function renderStep(step: StepView, isNext: boolean, act: (command: PanelCommand) => void): HTMLElement {
  const head = element("div", { className: "step-head" }, [
    element("span", { text: `${step.index}.` }),
    element("span", { text: step.title }),
    element("span", {
      className: `tag ${step.kind}`,
      text: step.kind === "navigate" ? "Opens a page" : "You do this",
    }),
  ]);
  const buttons = element("div", { className: "actions" });
  if (step.canOpen) {
    const open = element("button", { text: "Open page" });
    open.addEventListener("click", () => act({ type: "OPEN_STEP", index: step.index }));
    buttons.append(open);
  }
  if (step.canShow) {
    const show = element("button", { className: "secondary", text: "Show on page" });
    show.addEventListener("click", () => act({ type: "SHOW_STEP", index: step.index }));
    buttons.append(show);
  }
  const done = element("button", { className: "secondary", text: step.done ? "Undo done" : "Mark done" });
  done.addEventListener("click", () => act({ type: "MARK_DONE", index: step.index, done: !step.done }));
  buttons.append(done);

  const sources =
    step.citations.length === 0
      ? undefined
      : element("details", {}, [
          element("summary", { text: `Source${step.citations.length > 1 ? "s" : ""} (${step.citations.length})` }),
          ...step.citations.map((citation) =>
            element("blockquote", { text: `${citation.pageTitle || citation.pageUrl}: “${citation.excerpt}”` }),
          ),
        ]);

  return element(
    "li",
    { className: `step${isNext ? " next" : ""}${step.done ? " done" : ""}` },
    [
      isNext ? element("div", { className: "next-label", text: "Next step" }) : undefined,
      head,
      element("div", { text: step.instruction }),
      step.manualNote === undefined ? undefined : element("div", { className: "manual-note", text: step.manualNote }),
      buttons,
      sources,
    ],
  );
}

function renderView(view: GuidanceView, act: (command: PanelCommand) => void): HTMLElement[] {
  const header = element("section", { className: "card" }, [
    element("span", { className: `status ${view.availability}`, text: view.headline }),
    view.goal === undefined ? undefined : element("p", { className: "goal", text: `Goal: ${view.goal}` }),
    element("p", { text: view.message }),
    ...view.notices.map((notice) => element("div", { className: "warning", text: notice })),
    view.missingFactLabels.length === 0
      ? undefined
      : element("div", { className: "warning", text: `Still needed: ${view.missingFactLabels.join(", ")}` }),
    view.sourceLabel === undefined
      ? undefined
      : element("p", { className: "guidance-only", text: view.sourceLabel }),
    element("p", {
      className: "guidance-only",
      text: "Guidance only. This extension never clicks, submits, cancels or sends anything for you. " + minutes(view.remainingMs),
    }),
  ]);
  const sections: HTMLElement[] = [header];
  if (view.steps.length > 0) {
    const list = element("ol", { className: "steps" });
    for (const step of view.steps) list.append(renderStep(step, step.index === view.nextStepIndex, act));
    sections.push(element("section", {}, [element("h2", { text: "Your route" }), list]));
  }
  return sections;
}

function renderDemoControls(
  fixtures: PanelResponse["fixtures"],
  act: (command: PanelCommand) => void,
  selected: string,
  onSelect: (id: string) => void,
): HTMLElement {
  const select = element("select");
  select.setAttribute("aria-label", "Fixture scenario");
  for (const fixture of fixtures) {
    const option = element("option", { text: fixture.label });
    option.value = fixture.id;
    option.selected = fixture.id === selected;
    select.append(option);
  }
  select.addEventListener("change", () => onSelect(select.value));
  const load = element("button", { text: "Load scenario" });
  load.addEventListener("click", () => act({ type: "LOAD_FIXTURE", fixtureId: select.value }));
  const invalidate = element("button", { className: "secondary", text: "Invalidate session" });
  invalidate.addEventListener("click", () => act({ type: "INVALIDATE" }));
  const reset = element("button", { className: "secondary", text: "Reset demo" });
  reset.addEventListener("click", () => act({ type: "RESET" }));
  const clear = element("button", { className: "secondary", text: "Clear highlight" });
  clear.addEventListener("click", () => act({ type: "CLEAR_HIGHLIGHT" }));
  return element("section", { className: "demo" }, [
    element("strong", { text: "Demo controls (fixture mode)" }),
    element("div", { text: "Scenarios are prebuilt from recorded/hand-authored fixtures run through the deterministic pipeline. Loading one stands in for the Slayer app publishing a plan." }),
    select,
    element("div", { className: "actions" }, [load, invalidate, reset, clear]),
  ]);
}

let selectedFixture = "";
let latest: PanelResponse | undefined;

function paint(): void {
  if (root === null || latest === undefined) return;
  const response = latest;
  if (selectedFixture === "") selectedFixture = response.fixtures[0]?.id ?? "";
  const act = (command: PanelCommand): void => {
    void send(command).then((next) => {
      feedback = describeOutcome(next.outcome, next.detail);
      latest = next;
      paint();
    });
  };
  const children: HTMLElement[] = [
    element("div", {
      className: "banner",
      text: "FIXTURE DEMONSTRATION. This panel is not live-synchronized with the Bureaucracy Slayer app; routes come from prebuilt, verified fixtures.",
    }),
    ...renderView(response.view, act),
  ];
  if (feedback !== undefined) {
    children.push(element("div", { className: `feedback${feedback.warn ? " warn" : ""}`, text: feedback.text }));
  }
  children.push(renderDemoControls(response.fixtures, act, selectedFixture, (id) => { selectedFixture = id; }));
  root.replaceChildren(...children);
}

let refreshInFlight = false;

async function refresh(): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const next = await send({ type: "GET_VIEW" });
    const unchanged = latest !== undefined && viewFingerprint(latest.view) === viewFingerprint(next.view);
    latest = next;
    if (!unchanged) paint();
    else if (root !== null && root.childElementCount === 0) paint();
  } finally {
    refreshInFlight = false;
  }
}

void refresh();
window.setInterval(() => void refresh(), 30_000);
chrome.storage.onChanged.addListener(() => void refresh());
