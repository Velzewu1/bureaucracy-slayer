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

let responseSerial = 0;

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
    case "unsupported_goal":
    case "goal_required":
      return undefined;
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
    case "review_required":
    case "stale":
      return "hold";
    case "blocked":
    case "rejected":
    case "invalidated":
    case "expired":
    case "superseded":
      return "stop";
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
  const toggle = element("button", { className: "step-toggle", text: step.title });
  toggle.type = "button";
  toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  toggle.addEventListener("click", onToggle);

  const buttons = element("div", { className: "actions" });
  if (expanded && step.canOpen) {
    const open = element("button", { className: "primary", text: "Open page" });
    open.addEventListener("click", () => act({ type: "OPEN_STEP", index: step.index }));
    buttons.append(open);
  }
  if (expanded && step.canShow) {
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
          element("summary", { text: "View supporting evidence" }),
          ...step.citations.map((citation) =>
            element("blockquote", { text: `${citation.pageTitle || citation.pageUrl}: “${citation.excerpt}”` }),
          ),
        ]);

  const classes = ["step", step.kind, expanded ? "expanded" : "compact", options.active ? "next" : "", step.done ? "done" : ""]
    .filter((value) => value !== "")
    .join(" ");

  return element("li", { className: classes }, [
    element("span", { className: "step-index", text: String(step.index).padStart(2, "0") }),
    element("div", { className: "step-body" }, [
      options.active
        ? element("div", { className: "next-label", text: `Step ${step.index} of ${options.total}` })
        : undefined,
      element("div", { className: "step-kindline" }, [
        element("span", { className: `tag ${step.kind}`, text: kindLabel }),
      ]),
      toggle,
      expanded ? element("p", { className: "step-copy", text: step.instruction }) : undefined,
      step.manualNote === undefined
        ? undefined
        : element("p", {
            className: "manual-note",
            text: expanded ? step.manualNote : "The extension will never click it.",
          }),
      expanded ? sources : undefined,
      buttons,
    ]),
  ]);
}

function renderView(view: GuidanceView, act: (command: PanelCommand) => void): HTMLElement[] {
  const kind = statusKind(view.availability);
  const remaining = minutes(view.remainingMs);
  const summary = element("section", { className: `card summary summary-${kind}` }, [
    element("p", {
      className: `status status-${kind} ${view.availability}`,
      text: view.headline,
    }),
    view.goal === undefined ? undefined : element("p", { className: "goal", text: view.goal }),
    element("p", { className: "decision-copy", text: view.message }),
    view.sourceLabel === undefined
      ? undefined
      : element("p", { className: "source-line", text: view.sourceLabel }),
    element("p", { className: "safety-line", text: "Guidance only. This extension does not click or submit anything." }),
    view.missingFactLabels.length === 0
      ? undefined
      : element("p", { className: "needed", text: `Still needed: ${view.missingFactLabels.join(", ")}` }),
    remaining === undefined ? undefined : element("p", { className: "meta", text: remaining }),
  ]);
  const sections: HTMLElement[] = [summary];
  if (view.notices.length > 0) {
    sections.push(
      element("details", { className: "reason" }, [
        element("summary", { text: "Why this route?" }),
        ...view.notices.map((notice) => element("p", { text: notice })),
      ]),
    );
  }
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
    element("summary", { text: "Developer / Demo controls" }),
    element("p", { className: "demo-help", text: "Testing only. Normal use is the goal box above. These routes are prebuilt fixtures, not a live analysis." }),
    select,
    element("div", { className: "actions" }, [load, invalidate, reset, clear]),
  ]);
  if (demoOpen) details.setAttribute("open", "");
  details.addEventListener("toggle", () => {
    demoOpen = details.open;
  });
  return details;
}

function renderPersonalization(
  response: PanelResponse,
  act: (command: PanelCommand) => void,
): HTMLElement | undefined {
  if (!response.canPersonalize) return undefined;
  const guided = element("button", { className: response.factMode === "guided" ? "mode selected" : "mode", text: "Guided" });
  guided.type = "button";
  guided.setAttribute("aria-pressed", response.factMode === "guided" ? "true" : "false");
  guided.addEventListener("click", () => act({ type: "SET_FACT_MODE", mode: "guided" }));
  const all = element("button", { className: response.factMode === "all" ? "mode selected" : "mode", text: "All facts" });
  all.type = "button";
  all.setAttribute("aria-pressed", response.factMode === "all" ? "true" : "false");
  all.addEventListener("click", () => act({ type: "SET_FACT_MODE", mode: "all" }));
  const fields = response.questions.map((question) => {
    const field = element("fieldset", { className: "question" }, [
      element("legend", { text: question.label }),
    ]);
    for (const option of question.options) {
      const choice = element("button", { className: "choice", text: option.label });
      choice.type = "button";
      choice.setAttribute("aria-pressed", question.selectedOptionId === option.id ? "true" : "false");
      choice.addEventListener("click", () => act({ type: "ANSWER", questionId: question.id, optionId: option.id }));
      field.append(choice);
    }
    return field;
  });
  return element("section", { className: "card facts" }, [
    element("div", { className: "mode-toggle" }, [guided, all]),
    fields.length === 0
      ? element("p", { className: "demo-help", text: "Guided questions are answered. Switch to All facts to change one." })
      : undefined,
    ...fields,
  ]);
}

let selectedFixture = "";
let latest: PanelResponse | undefined;
let expandedIndex: number | undefined;
let demoOpen = false;
let lastAvailability: GuidanceView["availability"] | undefined;
let shellReady = false;
let resultsHost: HTMLElement | undefined;
let demoHost: HTMLElement | undefined;
let draftGoal = "";
let busy = false;

function ensureShell(): void {
  if (shellReady || root === null) return;
  const label = element("label", { className: "field-label", text: "Your goal" });
  label.htmlFor = "user-goal";
  const input = element("textarea", { className: "goal-input" });
  input.id = "user-goal";
  input.maxLength = 2_000;
  input.placeholder = "Can I cancel my scheduled bank transfer?";
  input.value = draftGoal;
  input.addEventListener("input", () => {
    draftGoal = input.value;
    feedback = undefined;
    const serial = ++responseSerial;
    void send({ type: "GOAL_EDITED", goal: draftGoal }).then((next) => {
      if (serial !== responseSerial) return;
      busy = false;
      latest = next;
      paint();
    });
  });
  const analyze = element("button", { className: "primary", text: "Analyze Website" });
  analyze.type = "button";
  analyze.addEventListener("click", () => {
    busy = true;
    paint();
    const serial = ++responseSerial;
    void send({ type: "ANALYZE", goal: draftGoal }).then((next) => {
      if (serial !== responseSerial) return;
      busy = false;
      feedback = describeOutcome(next.outcome, next.detail);
      if (viewFingerprint(latest?.view ?? next.view) !== viewFingerprint(next.view)) {
        expandedIndex = next.view.nextStepIndex;
        lastAvailability = next.view.availability;
      }
      latest = next;
      paint();
    });
  });
  resultsHost = element("div", { className: "results" });
  demoHost = element("div", { className: "demo-host" });
  root.append(
    element("header", { className: "brand" }, [
      element("span", { className: "brand-mark", text: "BS" }),
      element("div", { className: "brand-copy" }, [
        element("strong", { text: "Bureaucracy Slayer" }),
        element("span", { text: "Northstar Mock Bank" }),
      ]),
      element("span", { className: "provenance", text: "Offline fixture" }),
    ]),
    element("section", { className: "card goal-form" }, [label, input, analyze]),
    resultsHost,
    demoHost,
  );
  shellReady = true;
}

function paint(): void {
  if (root === null || latest === undefined) return;
  ensureShell();
  if (resultsHost === undefined || demoHost === undefined) return;
  const response = latest;
  if (selectedFixture === "") selectedFixture = response.fixtures[0]?.id ?? "";
  if (lastAvailability !== response.view.availability || expandedIndex === undefined) {
    expandedIndex = response.view.nextStepIndex;
  }
  lastAvailability = response.view.availability;
  const act = (command: PanelCommand): void => {
    const serial = ++responseSerial;
    void send(command).then((next) => {
      if (serial !== responseSerial) return;
      busy = false;
      feedback = describeOutcome(next.outcome, next.detail);
      if (command.type === "LOAD_FIXTURE" && next.outcome !== "rejected_fixture") demoOpen = false;
      if (viewFingerprint(response.view) !== viewFingerprint(next.view)) {
        expandedIndex = next.view.nextStepIndex;
        lastAvailability = next.view.availability;
      }
      latest = next;
      paint();
    });
  };
  const results: HTMLElement[] = [];
  if (busy) {
    results.push(element("section", { className: "card" }, [
      element("p", { className: "decision-copy", text: "Checking the offline demonstration…" }),
    ]));
  } else {
    if (response.notice !== undefined) {
      results.push(element("p", { className: "alert", text: response.notice }));
    }
    const personalization = renderPersonalization(response, act);
    if (personalization !== undefined) results.push(personalization);
    results.push(...renderView(response.view, act));
    if (feedback !== undefined) {
      results.push(element("div", { className: `feedback${feedback.warn ? " warn" : ""}`, text: feedback.text }));
    }
  }
  resultsHost.replaceChildren(...results);
  demoHost.replaceChildren(renderDemoControls(response.fixtures, act, selectedFixture, (id) => {
    selectedFixture = id;
  }));
}

let refreshInFlight = false;

async function refresh(): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const serial = responseSerial;
    const next = await send({ type: "GET_VIEW" });
    if (serial !== responseSerial) return;
    const unchanged = latest !== undefined && viewFingerprint(latest.view) === viewFingerprint(next.view) && latest.factMode === next.factMode && latest.notice === next.notice;
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
