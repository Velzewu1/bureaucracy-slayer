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
      return { text: "Opened the Northstar page. Nothing was clicked.", warn: false };
    case "highlighted":
      return { text: "Highlighted on the page. Complete the action yourself.", warn: false };
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

function minutes(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  return `About ${Math.max(1, Math.ceil(ms / 60000))} min left`;
}

function statusKind(availability: GuidanceView["availability"]): string {
  switch (availability) {
    case "ready":
      return "ok";
    case "needs_information":
      return "info";
    case "blocked":
    case "rejected":
      return "stop";
    case "review_required":
    case "stale":
    case "expired":
    case "invalidated":
    case "superseded":
      return "hold";
    default:
      return "idle";
  }
}

function renderStep(
  step: StepView,
  options: Readonly<{ active: boolean; total: number; expanded: boolean }>,
  act: (command: PanelCommand) => void,
  onToggle: () => void,
): HTMLElement {
  const expanded = options.expanded;
  const kindLabel = step.kind === "navigate" ? "Opens a page" : "You do this";
  const toggle = element("button", {
    className: "step-toggle",
    text: step.title,
  });
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  toggle.addEventListener("click", onToggle);

  const head = element("div", { className: "step-head" }, [
    element("span", { className: "step-index", text: String(step.index) }),
    toggle,
    element("span", { className: `tag ${step.kind}`, text: kindLabel }),
  ]);

  const buttons = element("div", { className: "actions" });
  if (step.canOpen) {
    const open = element("button", { className: expanded ? "primary" : "secondary", text: "Open page" });
    open.addEventListener("click", () => act({ type: "OPEN_STEP", index: step.index }));
    buttons.append(open);
  }
  if (step.canShow) {
    const show = element("button", { className: "secondary", text: "Show on page" });
    show.addEventListener("click", () => act({ type: "SHOW_STEP", index: step.index }));
    buttons.append(show);
  }
  const done = element("button", { className: "ghost", text: step.done ? "Undo done" : "Mark done" });
  done.addEventListener("click", () => act({ type: "MARK_DONE", index: step.index, done: !step.done }));
  buttons.append(done);

  const sources =
    step.citations.length === 0
      ? undefined
      : element("details", { className: "sources" }, [
          element("summary", { text: `Source${step.citations.length > 1 ? "s" : ""} (${step.citations.length})` }),
          ...step.citations.map((citation) =>
            element("blockquote", { text: `${citation.pageTitle || citation.pageUrl}: “${citation.excerpt}”` }),
          ),
        ]);

  const classes = ["step", step.kind, expanded ? "expanded" : "compact", options.active ? "next" : "", step.done ? "done" : ""]
    .filter((value) => value !== "")
    .join(" ");

  return element("li", { className: classes }, [
    options.active
      ? element("div", { className: "next-label", text: `Step ${step.index} of ${options.total}` })
      : undefined,
    head,
    expanded ? element("p", { className: "step-copy", text: step.instruction }) : undefined,
    step.manualNote === undefined
      ? undefined
      : element("p", { className: "manual-note", text: expanded ? step.manualNote : "The extension will never click it." }),
    buttons,
    expanded ? sources : undefined,
  ]);
}

function renderView(view: GuidanceView, act: (command: PanelCommand) => void): HTMLElement[] {
  const remaining = minutes(view.remainingMs);
  const header = element("section", { className: "card decision" }, [
    element("p", {
      className: `status status-${statusKind(view.availability)} ${view.availability}`,
      text: view.headline,
    }),
    view.goal === undefined ? undefined : element("p", { className: "goal", text: view.goal }),
    element("p", { className: "decision-copy", text: view.message }),
    ...view.notices.map((notice) => element("div", { className: "warning", text: notice })),
    view.missingFactLabels.length === 0
      ? undefined
      : element("div", { className: "warning", text: `Still needed: ${view.missingFactLabels.join(", ")}` }),
    remaining === undefined ? undefined : element("p", { className: "meta", text: remaining }),
  ]);
  const sections: HTMLElement[] = [header];
  if (view.steps.length > 0) {
    const list = element("ol", { className: "steps" });
    for (const step of view.steps) {
      const active = step.index === view.nextStepIndex;
      const expanded = step.index === expandedIndex;
      list.append(
        renderStep(step, { active, total: view.steps.length, expanded }, act, () => {
          expandedIndex = expandedIndex === step.index ? view.nextStepIndex : step.index;
          paint();
        }),
      );
    }
    sections.push(element("section", { className: "route" }, [element("h2", { text: "Your route" }), list]));
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
  const load = element("button", { className: "primary", text: "Load scenario" });
  load.addEventListener("click", () => act({ type: "LOAD_FIXTURE", fixtureId: select.value }));
  const invalidate = element("button", { className: "secondary", text: "Invalidate session" });
  invalidate.addEventListener("click", () => act({ type: "INVALIDATE" }));
  const reset = element("button", { className: "secondary", text: "Reset demo" });
  reset.addEventListener("click", () => act({ type: "RESET" }));
  const clear = element("button", { className: "ghost", text: "Clear highlight" });
  clear.addEventListener("click", () => act({ type: "CLEAR_HIGHLIGHT" }));
  const details = element("details", { className: "demo-controls" }, [
    element("summary", { text: "Demo controls" }),
    element("p", { className: "demo-help", text: "Loading a scenario stands in for the Slayer app publishing a plan." }),
    select,
    element("div", { className: "actions" }, [load, invalidate, reset, clear]),
  ]);
  if (demoOpen) details.setAttribute("open", "");
  details.addEventListener("toggle", () => {
    demoOpen = details.open;
  });
  return details;
}

let selectedFixture = "";
let latest: PanelResponse | undefined;
let expandedIndex: number | undefined;
let demoOpen = false;
let lastAvailability: GuidanceView["availability"] | undefined;

function paint(): void {
  if (root === null || latest === undefined) return;
  const response = latest;
  if (selectedFixture === "") selectedFixture = response.fixtures[0]?.id ?? "";
  if (lastAvailability !== response.view.availability || expandedIndex === undefined) {
    expandedIndex = response.view.nextStepIndex;
  }
  lastAvailability = response.view.availability;
  const act = (command: PanelCommand): void => {
    void send(command).then((next) => {
      feedback = describeOutcome(next.outcome, next.detail);
      if (viewFingerprint(response.view) !== viewFingerprint(next.view)) {
        expandedIndex = next.view.nextStepIndex;
        lastAvailability = next.view.availability;
      }
      latest = next;
      paint();
    });
  };
  const children: HTMLElement[] = [
    element("header", { className: "brand" }, [
      element("span", { className: "brand-mark", text: "BS" }),
      element("div", { className: "brand-copy" }, [
        element("strong", { text: "Bureaucracy Slayer" }),
        element("span", { text: "Northstar Mock Bank" }),
      ]),
    ]),
    element("p", { className: "mode-chip", text: "Demo mode · Verified fixture" }),
    element("p", { className: "mode-note", text: "Routes come from prebuilt fixtures, not a live analysis." }),
    ...renderView(response.view, act),
  ];
  if (feedback !== undefined) {
    children.push(element("div", { className: `feedback${feedback.warn ? " warn" : ""}`, text: feedback.text }));
  }
  children.push(renderDemoControls(response.fixtures, act, selectedFixture, (id) => { selectedFixture = id; }));
  children.push(element("p", { className: "footer", text: "Guidance only · never clicks, submits, or cancels for you." }));
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
