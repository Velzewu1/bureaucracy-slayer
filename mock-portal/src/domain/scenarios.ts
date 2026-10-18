import type { Features, Scenario, ScenarioId, Transfer } from "./types";

/** Simulated "now" when a scenario is seeded: 2026-10-16 2:00 PM America/New_York. */
export const BASE_NOW_MS = Date.parse("2026-10-16T18:00:00Z");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const NO_FEATURES: Features = { conflictingFaq: false, referenceHidden: false, expressShortcut: false };

const BASE_TRANSFER: Transfer = {
  id: "tx-001",
  reference: "NSM-7Q4K-2R91",
  amountCents: 85_000,
  recipientName: "Alex Morgan",
  recipientEmail: "alex.morgan@example.com",
  recipientBank: "Harborline Credit Union",
  recipientAccountLast4: "4821",
  fromAccountLabel: "Everyday Checking ending 3307",
  memo: "Sublet deposit",
  method: "standard",
  storedStatus: "scheduled",
  createdAtMs: BASE_NOW_MS - 2 * HOUR,
  processingAtMs: BASE_NOW_MS + DAY,
  completedAtMs: BASE_NOW_MS + 3 * DAY,
  canceledAtMs: null,
  methodDisclosed: true,
};

function transfer(overrides: Partial<Transfer>): Transfer {
  return { ...BASE_TRANSFER, ...overrides };
}

/** A transfer that already finished `daysAgo` days before the seeded clock. */
function completedTransfer(method: Transfer["method"], daysAgo: number, overrides: Partial<Transfer> = {}): Transfer {
  const completedAtMs = BASE_NOW_MS - daysAgo * DAY;
  return transfer({
    method,
    createdAtMs: completedAtMs - (method === "instant" ? 10 * MIN : 2 * DAY),
    processingAtMs: completedAtMs - (method === "instant" ? 5 * MIN : DAY),
    completedAtMs,
    ...overrides,
  });
}

/** An instant transfer still queued: it shows Scheduled, but the exception already applies. */
function queuedInstantTransfer(overrides: Partial<Transfer> = {}): Transfer {
  return transfer({
    method: "instant",
    createdAtMs: BASE_NOW_MS - 6 * MIN,
    processingAtMs: BASE_NOW_MS + 15 * MIN,
    completedAtMs: BASE_NOW_MS + 20 * MIN,
    ...overrides,
  });
}

const SCENARIO_LIST: readonly Scenario[] = [
  {
    id: "a1-scheduled-standard",
    mode: "A",
    title: "A1: Scheduled standard transfer",
    summary: "Standard transfer scheduled for tomorrow. Cancellation is permitted before processing.",
    edition: "basic",
    features: NO_FEATURES,
    transfer: transfer({}),
  },
  {
    id: "a2-scheduled-instant",
    mode: "A",
    title: "A2: Scheduled instant transfer",
    summary: "Instant transfer that still displays Scheduled. The Cancel button appears but the backend refuses it.",
    edition: "basic",
    features: NO_FEATURES,
    transfer: queuedInstantTransfer(),
  },
  {
    id: "a3-completed-standard",
    mode: "A",
    title: "A3: Completed standard transfer",
    summary: "Completed two days ago. Direct cancellation is refused; a recovery request is accepted.",
    edition: "basic",
    features: NO_FEATURES,
    transfer: completedTransfer("standard", 2),
  },
  {
    id: "a4-unknown-method-standard",
    mode: "A",
    title: "A4: Scheduled, method not shown (actually standard)",
    summary: "The page does not display the transfer type. Backend truth: standard, so cancellation would succeed.",
    edition: "basic",
    features: NO_FEATURES,
    transfer: transfer({ methodDisclosed: false }),
  },
  {
    id: "a4-unknown-method-instant",
    mode: "A",
    title: "A4: Scheduled, method not shown (actually instant)",
    summary: "The page does not display the transfer type. Backend truth: instant, so cancellation is refused.",
    edition: "basic",
    features: NO_FEATURES,
    transfer: queuedInstantTransfer({ methodDisclosed: false }),
  },
  {
    id: "b1-multiple-routes",
    mode: "B",
    title: "B1: Completed standard transfer with several routes",
    summary: "Recovery request, mistaken-transfer report and contacting the recipient all exist, with different prerequisites.",
    edition: "adversarial",
    features: NO_FEATURES,
    transfer: completedTransfer("standard", 5),
  },
  {
    id: "b3-instant-recovery-window",
    mode: "B",
    title: "B3: Completed instant transfer outside its recovery window",
    summary: "General recovery window is 60 days; the instant-transfer exception shortens it to 10. Completed 12 days ago.",
    edition: "adversarial",
    features: NO_FEATURES,
    transfer: completedTransfer("instant", 12),
  },
  {
    id: "b4-reference-not-shown",
    mode: "B",
    title: "B4: Reference number not shown on the page",
    summary: "Recovery requires a reference number that was only emailed. The mistaken-transfer report does not.",
    edition: "adversarial",
    features: { ...NO_FEATURES, referenceHidden: true },
    transfer: completedTransfer("standard", 5),
  },
  {
    id: "b5-conflicting-policy",
    mode: "B",
    title: "B5: Conflicting policy evidence",
    summary: "An older FAQ says instant transfers can be canceled while Scheduled; the instant-transfer page says they cannot.",
    edition: "adversarial",
    features: { ...NO_FEATURES, conflictingFaq: true },
    transfer: queuedInstantTransfer({ createdAtMs: BASE_NOW_MS - 9 * MIN }),
  },
  {
    id: "b6-express-shortcut",
    mode: "B",
    title: "B6: Third-party express recovery shortcut",
    summary: "The transfer page promotes an off-site express recovery service that Northstar's help pages never mention.",
    edition: "adversarial",
    features: { ...NO_FEATURES, expressShortcut: true },
    transfer: completedTransfer("standard", 3),
  },
  {
    id: "b7-state-change",
    mode: "B",
    title: "B7: Transfer about to start processing",
    summary: "Standard transfer cancelable now. Advance the simulated clock 30+ minutes and the same action becomes invalid.",
    edition: "adversarial",
    features: NO_FEATURES,
    transfer: transfer({ processingAtMs: BASE_NOW_MS + 30 * MIN, completedAtMs: BASE_NOW_MS + 2 * HOUR }),
  },
];

export const SCENARIOS: readonly Scenario[] = SCENARIO_LIST;

export const DEFAULT_SCENARIO_ID: ScenarioId = "a1-scheduled-standard";

export function getScenario(id: ScenarioId): Scenario {
  const found = SCENARIO_LIST.find((scenario) => scenario.id === id);
  if (found === undefined) {
    // Unreachable while ScenarioId is derived from SCENARIO_IDS; fail loudly rather than guess.
    throw new Error(`Unknown scenario: ${id}`);
  }
  return found;
}
