// Authoritative transaction rules for Northstar Mock Bank.
//
// Everything here is pure: functions take a PortalState and return a result (and, where
// applicable, a new state). The UI never decides eligibility; it only calls these functions.
// Policy references (P1..P8) in comments map to the fictional ground-truth policies in docs/.

import { getScenario } from "./scenarios";
import { isoDateInPortalZone, parseAmountToCents } from "./format";
import type { CaseKind, EffectiveStatus, PortalState, SupportCase, Transfer } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Adversarial edition only: general recovery window and the shorter instant-transfer window. */
export const RECOVERY_WINDOW_DAYS_GENERAL = 60;
export const RECOVERY_WINDOW_DAYS_INSTANT = 10;

export const RECOVERY_REASONS = ["wrong_recipient", "wrong_amount", "duplicate_payment"] as const;
export const MISTAKEN_ISSUES = ["wrong_recipient", "wrong_amount", "duplicate_payment"] as const;

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

export function listTransfers(state: PortalState): readonly Transfer[] {
  const base = getScenario(state.scenarioId).transfer;
  const canceledAtMs = state.canceledAtMs[base.id];
  if (canceledAtMs === undefined) return [base];
  return [{ ...base, storedStatus: "canceled", canceledAtMs }];
}

export function findTransferById(state: PortalState, id: string): Transfer | undefined {
  return listTransfers(state).find((transfer) => transfer.id === id);
}

/** Status at `nowMs`: completion and processing are derived from the simulated clock. */
export function effectiveStatus(transfer: Transfer, nowMs: number): EffectiveStatus {
  if (transfer.storedStatus === "canceled") return "canceled";
  if (nowMs >= transfer.completedAtMs) return "completed";
  if (nowMs >= transfer.processingAtMs) return "processing";
  return transfer.storedStatus;
}

export function recoveryWindowDays(state: PortalState, transfer: Transfer): number | null {
  if (getScenario(state.scenarioId).edition !== "adversarial") return null;
  return transfer.method === "instant" ? RECOVERY_WINDOW_DAYS_INSTANT : RECOVERY_WINDOW_DAYS_GENERAL;
}

// ---------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------

export function advanceClock(state: PortalState, deltaMs: number): PortalState {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) return state;
  return { ...state, nowMs: state.nowMs + deltaMs };
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export type CancelDenialCode =
  | "TRANSFER_NOT_FOUND"
  | "ALREADY_CANCELED"
  | "COMPLETED_NOT_CANCELABLE" // P3
  | "INSTANT_NOT_CANCELABLE" // P2 (takes precedence over the general P1 permission, see P8)
  | "PROCESSING_STARTED"; // P7

export type CancelOutcome =
  | { readonly kind: "canceled"; readonly state: PortalState }
  | { readonly kind: "denied"; readonly code: CancelDenialCode; readonly message: string };

/** Evaluated against the state at the moment of the call (P7), never against what a page showed earlier. */
export function cancelTransfer(state: PortalState, transferId: string): CancelOutcome {
  const transfer = findTransferById(state, transferId);
  if (transfer === undefined) {
    return { kind: "denied", code: "TRANSFER_NOT_FOUND", message: "We couldn't find that transfer." };
  }

  const status = effectiveStatus(transfer, state.nowMs);

  if (status === "canceled") {
    return { kind: "denied", code: "ALREADY_CANCELED", message: "This transfer has already been canceled." };
  }
  if (status === "completed") {
    return {
      kind: "denied",
      code: "COMPLETED_NOT_CANCELABLE",
      message:
        "This transfer has already completed and can't be canceled. You may be able to submit a recovery request instead.",
    };
  }
  if (transfer.method === "instant") {
    return {
      kind: "denied",
      code: "INSTANT_NOT_CANCELABLE",
      message:
        "Instant transfers can't be canceled once they've been submitted, even though this transfer still shows a pending or scheduled status.",
    };
  }
  if (status === "processing") {
    return {
      kind: "denied",
      code: "PROCESSING_STARTED",
      message:
        "Processing started for this transfer after you opened the page, so it can no longer be canceled. Nothing was changed.",
    };
  }

  // P1: a scheduled (or pending) standard transfer that has not started processing.
  return {
    kind: "canceled",
    state: { ...state, canceledAtMs: { ...state.canceledAtMs, [transfer.id]: state.nowMs } },
  };
}

/** State to persist after a cancellation attempt, or null when nothing changed. */
export function stateAfterCancel(outcome: CancelOutcome): PortalState | null {
  return outcome.kind === "canceled" ? outcome.state : null;
}

// ---------------------------------------------------------------------------
// Support forms
// ---------------------------------------------------------------------------

export type FieldErrors = Readonly<Record<string, string>>;

export type FormDenialCode =
  | "TRANSFER_NOT_MATCHED"
  | "TRANSFER_CANCELED"
  | "NOT_COMPLETED_YET"
  | "RECOVERY_WINDOW_EXPIRED"
  | "DUPLICATE_CASE"
  | "USE_UNAUTHORIZED_FORM" // P6
  | "USE_MISTAKEN_FORM"; // P6

export type FormOutcome =
  | { readonly kind: "invalid"; readonly fieldErrors: FieldErrors }
  | { readonly kind: "denied"; readonly code: FormDenialCode; readonly message: string }
  | {
      readonly kind: "accepted";
      readonly state: PortalState;
      readonly caseId: string;
      readonly handling: SupportCase["handling"];
      readonly message: string;
    };

/** State to persist after a form submission, or null when nothing changed. */
export function stateAfterForm(outcome: FormOutcome): PortalState | null {
  return outcome.kind === "accepted" ? outcome.state : null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function isValidIsoDate(value: string): boolean {
  return ISO_DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isOneOf<T extends string>(options: readonly T[], value: string): value is T {
  return (options as readonly string[]).includes(value);
}

function normalizeReference(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function caseIdPrefix(kind: CaseKind): string {
  switch (kind) {
    case "payment_recovery":
      return "REC";
    case "mistaken_transfer":
      return "MIS";
    case "unauthorized_transfer":
      return "UNA";
  }
}

function openCase(
  state: PortalState,
  kind: CaseKind,
  transfer: Transfer,
  handling: SupportCase["handling"],
): { readonly state: PortalState; readonly caseId: string } {
  const caseId = `${caseIdPrefix(kind)}-${100001 + state.cases.length}`;
  const created: SupportCase = { id: caseId, kind, transferId: transfer.id, createdAtMs: state.nowMs, handling };
  return { state: { ...state, cases: [...state.cases, created] }, caseId };
}

function hasOpenCase(state: PortalState, kind: CaseKind, transfer: Transfer): boolean {
  return state.cases.some((existing) => existing.kind === kind && existing.transferId === transfer.id);
}

const DUPLICATE_MESSAGE =
  "We already have an open request of this type for that transfer. We'll email you once it has been reviewed.";

// --- Payment recovery (P4, P5) ------------------------------------------------

export interface RecoveryInput {
  readonly reference: string;
  readonly recipientName: string;
  readonly recipientBank: string;
  readonly recipientAccountLast4: string;
  readonly reason: string;
  readonly details: string;
  readonly contactEmail: string;
  readonly confirmAccurate: boolean;
}

export function submitPaymentRecovery(state: PortalState, input: RecoveryInput): FormOutcome {
  const errors: Record<string, string> = {};
  if (isBlank(input.reference)) errors["reference"] = "Enter the transaction reference number.";
  if (isBlank(input.recipientName)) errors["recipientName"] = "Enter the recipient's full name.";
  if (isBlank(input.recipientBank)) errors["recipientBank"] = "Enter the recipient's bank or credit union.";
  if (!/^\d{4}$/.test(input.recipientAccountLast4.trim())) {
    errors["recipientAccountLast4"] = "Enter the last four digits of the recipient's account.";
  }
  if (!isOneOf(RECOVERY_REASONS, input.reason)) errors["reason"] = "Select a reason for the request.";
  if (input.details.trim().length < 20) errors["details"] = "Describe what happened in at least 20 characters.";
  if (!EMAIL_PATTERN.test(input.contactEmail.trim())) errors["contactEmail"] = "Enter a valid email address.";
  if (!input.confirmAccurate) errors["confirmAccurate"] = "Confirm that the information is accurate.";
  if (Object.keys(errors).length > 0) return { kind: "invalid", fieldErrors: errors };

  const reference = normalizeReference(input.reference);
  const transfer = listTransfers(state).find(
    (candidate) =>
      candidate.reference === reference &&
      normalizeName(candidate.recipientName) === normalizeName(input.recipientName) &&
      candidate.recipientAccountLast4 === input.recipientAccountLast4.trim(),
  );
  if (transfer === undefined) {
    return {
      kind: "denied",
      code: "TRANSFER_NOT_MATCHED",
      message:
        "We couldn't match that reference number and recipient information to a transfer on your account. Check the details and try again.",
    };
  }

  const status = effectiveStatus(transfer, state.nowMs);
  if (status === "canceled") {
    return {
      kind: "denied",
      code: "TRANSFER_CANCELED",
      message: "That transfer was canceled, so no money left your account and there is nothing to recover.",
    };
  }
  // P3/P4: only completed transfers are eligible for a recovery request.
  if (status !== "completed") {
    return {
      kind: "denied",
      code: "NOT_COMPLETED_YET",
      message:
        "Recovery requests can only be submitted after a transfer has completed. This transfer has not completed yet.",
    };
  }

  const windowDays = recoveryWindowDays(state, transfer);
  if (windowDays !== null && state.nowMs - transfer.completedAtMs > windowDays * DAY_MS) {
    return {
      kind: "denied",
      code: "RECOVERY_WINDOW_EXPIRED",
      message: `Recovery requests for ${transfer.method} transfers must be submitted within ${windowDays} days of completion. That window has closed for this transfer.`,
    };
  }

  if (hasOpenCase(state, "payment_recovery", transfer)) {
    return { kind: "denied", code: "DUPLICATE_CASE", message: DUPLICATE_MESSAGE };
  }

  const opened = openCase(state, "payment_recovery", transfer, "review");
  return {
    kind: "accepted",
    state: opened.state,
    caseId: opened.caseId,
    handling: "review",
    message:
      "Your recovery request has been submitted for review. Recovery is not guaranteed; it depends on the recipient's bank and whether the funds are still available.",
  };
}

// --- Shared lookup for reports that may not have a reference number ------------

interface TransferLookup {
  readonly reference: string;
  readonly transferDate: string;
  readonly amount: string;
}

function validateLookupFields(input: TransferLookup, errors: Record<string, string>): void {
  if (!isBlank(input.reference)) return;
  if (!isValidIsoDate(input.transferDate)) {
    errors["transferDate"] = "Enter the transfer date, or provide the reference number.";
  }
  if (parseAmountToCents(input.amount) === null) {
    errors["amount"] = "Enter the transfer amount, for example 850.00, or provide the reference number.";
  }
}

function lookupTransfer(state: PortalState, input: TransferLookup): Transfer | undefined {
  if (!isBlank(input.reference)) {
    const reference = normalizeReference(input.reference);
    return listTransfers(state).find((candidate) => candidate.reference === reference);
  }
  const cents = parseAmountToCents(input.amount);
  return listTransfers(state).find(
    (candidate) =>
      candidate.amountCents === cents && isoDateInPortalZone(candidate.createdAtMs) === input.transferDate,
  );
}

const NO_MATCH_MESSAGE =
  "We couldn't find a transfer on your account that matches those details. Check them and try again.";

// --- Mistaken transfer report (P6: only for transfers you started yourself) -----

export interface MistakenInput extends TransferLookup {
  readonly initiatedByMe: string;
  readonly recipientName: string;
  readonly recipientContact: string;
  readonly issueType: string;
  readonly details: string;
  readonly contactEmail: string;
  readonly confirmAccurate: boolean;
}

export function submitMistakenReport(state: PortalState, input: MistakenInput): FormOutcome {
  if (input.initiatedByMe !== "yes" && input.initiatedByMe !== "no") {
    return { kind: "invalid", fieldErrors: { initiatedByMe: "Tell us whether you started this transfer." } };
  }
  if (input.initiatedByMe === "no") {
    return {
      kind: "denied",
      code: "USE_UNAUTHORIZED_FORM",
      message:
        "A transfer you didn't start yourself is handled as an unauthorized transfer, not a mistaken one. Please use the Report an unauthorized transfer form.",
    };
  }

  const errors: Record<string, string> = {};
  validateLookupFields(input, errors);
  if (isBlank(input.recipientName)) errors["recipientName"] = "Enter the name of the person you sent money to.";
  if (isBlank(input.reference) && isBlank(input.recipientContact)) {
    errors["recipientContact"] = "Enter the recipient's email or phone number, or provide the reference number.";
  }
  if (!isOneOf(MISTAKEN_ISSUES, input.issueType)) errors["issueType"] = "Select what went wrong.";
  if (input.details.trim().length < 20) errors["details"] = "Describe what happened in at least 20 characters.";
  if (!EMAIL_PATTERN.test(input.contactEmail.trim())) errors["contactEmail"] = "Enter a valid email address.";
  if (!input.confirmAccurate) errors["confirmAccurate"] = "Confirm that the information is accurate.";
  if (Object.keys(errors).length > 0) return { kind: "invalid", fieldErrors: errors };

  const transfer = lookupTransfer(state, input);
  if (transfer === undefined) return { kind: "denied", code: "TRANSFER_NOT_MATCHED", message: NO_MATCH_MESSAGE };
  if (effectiveStatus(transfer, state.nowMs) === "canceled") {
    return {
      kind: "denied",
      code: "TRANSFER_CANCELED",
      message: "That transfer was canceled, so no money left your account.",
    };
  }
  if (hasOpenCase(state, "mistaken_transfer", transfer)) {
    return { kind: "denied", code: "DUPLICATE_CASE", message: DUPLICATE_MESSAGE };
  }

  // A report on a completed instant transfer past its recovery window is notification only.
  const windowDays = recoveryWindowDays(state, transfer);
  const pastWindow =
    windowDays !== null &&
    effectiveStatus(transfer, state.nowMs) === "completed" &&
    state.nowMs - transfer.completedAtMs > windowDays * DAY_MS;
  const handling: SupportCase["handling"] = pastWindow ? "outreach_only" : "review";

  const opened = openCase(state, "mistaken_transfer", transfer, handling);
  return {
    kind: "accepted",
    state: opened.state,
    caseId: opened.caseId,
    handling,
    message:
      handling === "outreach_only"
        ? "Your report has been recorded. Because the recovery window for this transfer has closed, we can notify the recipient's bank but cannot request that the money be returned."
        : "Your report has been recorded. A mistaken transfer report is not a recovery request and does not by itself return any money.",
  };
}

// --- Unauthorized transfer report (P6) -------------------------------------------

export interface UnauthorizedInput extends TransferLookup {
  readonly initiatedByMe: string;
  readonly dateNoticed: string;
  readonly accountSecured: string;
  readonly details: string;
  readonly contactEmail: string;
  readonly confirmAccurate: boolean;
}

export function submitUnauthorizedReport(state: PortalState, input: UnauthorizedInput): FormOutcome {
  if (input.initiatedByMe !== "yes" && input.initiatedByMe !== "no") {
    return { kind: "invalid", fieldErrors: { initiatedByMe: "Tell us whether you started this transfer." } };
  }
  if (input.initiatedByMe === "yes") {
    return {
      kind: "denied",
      code: "USE_MISTAKEN_FORM",
      message:
        "A transfer you started yourself, even by mistake, can't be reported as unauthorized. Please use the Report a mistaken transfer form instead.",
    };
  }

  const errors: Record<string, string> = {};
  validateLookupFields(input, errors);
  if (!isValidIsoDate(input.dateNoticed)) {
    errors["dateNoticed"] = "Enter the date you first noticed the transfer.";
  } else if (input.dateNoticed > isoDateInPortalZone(state.nowMs)) {
    errors["dateNoticed"] = "The date you noticed the transfer can't be in the future.";
  }
  if (input.accountSecured !== "yes" && input.accountSecured !== "no") {
    errors["accountSecured"] = "Tell us whether you have secured your account.";
  }
  if (input.details.trim().length < 20) errors["details"] = "Describe what happened in at least 20 characters.";
  if (!EMAIL_PATTERN.test(input.contactEmail.trim())) errors["contactEmail"] = "Enter a valid email address.";
  if (!input.confirmAccurate) errors["confirmAccurate"] = "Confirm that the information is accurate.";
  if (Object.keys(errors).length > 0) return { kind: "invalid", fieldErrors: errors };

  const transfer = lookupTransfer(state, input);
  if (transfer === undefined) return { kind: "denied", code: "TRANSFER_NOT_MATCHED", message: NO_MATCH_MESSAGE };
  if (hasOpenCase(state, "unauthorized_transfer", transfer)) {
    return { kind: "denied", code: "DUPLICATE_CASE", message: DUPLICATE_MESSAGE };
  }

  const opened = openCase(state, "unauthorized_transfer", transfer, "review");
  return {
    kind: "accepted",
    state: opened.state,
    caseId: opened.caseId,
    handling: "review",
    message:
      "Your unauthorized transfer report has been submitted. Our fraud team will contact you at the email address you provided.",
  };
}
