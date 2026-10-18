import { describe, expect, it } from "vitest";
import { formatMoney, parseAmountToCents } from "../../src/domain/format";
import {
  advanceClock,
  cancelTransfer,
  effectiveStatus,
  findTransferById,
  submitMistakenReport,
  submitPaymentRecovery,
  submitUnauthorizedReport,
} from "../../src/domain/rules";
import type { MistakenInput, RecoveryInput, UnauthorizedInput } from "../../src/domain/rules";
import { BASE_NOW_MS, SCENARIOS } from "../../src/domain/scenarios";
import type { PortalState, ScenarioId } from "../../src/domain/types";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function seed(scenarioId: ScenarioId): PortalState {
  return { schemaVersion: 1, scenarioId, nowMs: BASE_NOW_MS, canceledAtMs: {}, cases: [] };
}

function statusOf(state: PortalState): string {
  const transfer = findTransferById(state, "tx-001");
  if (transfer === undefined) throw new Error("tx-001 missing");
  return effectiveStatus(transfer, state.nowMs);
}

const RECOVERY: RecoveryInput = {
  reference: "NSM-7Q4K-2R91",
  recipientName: "Alex Morgan",
  recipientBank: "Harborline Credit Union",
  recipientAccountLast4: "4821",
  reason: "wrong_recipient",
  details: "I meant to send this to a different Alex.",
  contactEmail: "jamie@example.com",
  confirmAccurate: true,
};

const MISTAKEN: MistakenInput = {
  initiatedByMe: "yes",
  reference: "",
  transferDate: "",
  amount: "",
  recipientName: "Alex Morgan",
  recipientContact: "alex.morgan@example.com",
  issueType: "wrong_recipient",
  details: "I meant to send this to a different Alex.",
  contactEmail: "jamie@example.com",
  confirmAccurate: true,
};

const UNAUTHORIZED: UnauthorizedInput = {
  initiatedByMe: "no",
  reference: "NSM-7Q4K-2R91",
  transferDate: "",
  amount: "",
  dateNoticed: "2026-10-16",
  accountSecured: "yes",
  details: "I never made this transfer and do not know the recipient.",
  contactEmail: "jamie@example.com",
  confirmAccurate: true,
};

describe("scenario catalog", () => {
  it("has unique ids and a tx-001 for each scenario", () => {
    const ids = SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of SCENARIOS) expect(scenario.transfer.id).toBe("tx-001");
  });
});

describe("cancellation (P1, P2, P3, P7, P8)", () => {
  it("A1: permits canceling a scheduled standard transfer before processing", () => {
    const outcome = cancelTransfer(seed("a1-scheduled-standard"), "tx-001");
    expect(outcome.kind).toBe("canceled");
    if (outcome.kind === "canceled") expect(statusOf(outcome.state)).toBe("canceled");
  });

  it("A2: refuses an instant transfer even though it shows Scheduled", () => {
    const state = seed("a2-scheduled-instant");
    expect(statusOf(state)).toBe("scheduled");
    const outcome = cancelTransfer(state, "tx-001");
    expect(outcome).toMatchObject({ kind: "denied", code: "INSTANT_NOT_CANCELABLE" });
  });

  it("A3: refuses direct cancellation of a completed transfer", () => {
    const state = seed("a3-completed-standard");
    expect(statusOf(state)).toBe("completed");
    expect(cancelTransfer(state, "tx-001")).toMatchObject({ kind: "denied", code: "COMPLETED_NOT_CANCELABLE" });
  });

  it("A4: enforces the hidden true method, not what the page displays", () => {
    expect(cancelTransfer(seed("a4-unknown-method-standard"), "tx-001").kind).toBe("canceled");
    expect(cancelTransfer(seed("a4-unknown-method-instant"), "tx-001")).toMatchObject({
      kind: "denied",
      code: "INSTANT_NOT_CANCELABLE",
    });
  });

  it("B7/P7: the same action becomes invalid once processing starts", () => {
    const initial = seed("b7-state-change");
    expect(statusOf(initial)).toBe("scheduled");

    const later = advanceClock(initial, 31 * MIN);
    expect(statusOf(later)).toBe("processing");
    expect(cancelTransfer(later, "tx-001")).toMatchObject({ kind: "denied", code: "PROCESSING_STARTED" });

    const muchLater = advanceClock(initial, 3 * 60 * MIN);
    expect(statusOf(muchLater)).toBe("completed");
    expect(cancelTransfer(muchLater, "tx-001")).toMatchObject({ kind: "denied", code: "COMPLETED_NOT_CANCELABLE" });
  });

  it("B5: the conflicting FAQ does not change enforcement", () => {
    expect(cancelTransfer(seed("b5-conflicting-policy"), "tx-001")).toMatchObject({
      kind: "denied",
      code: "INSTANT_NOT_CANCELABLE",
    });
  });

  it("refuses a second cancellation and unknown transfers", () => {
    const first = cancelTransfer(seed("a1-scheduled-standard"), "tx-001");
    if (first.kind !== "canceled") throw new Error("expected first cancel to succeed");
    expect(cancelTransfer(first.state, "tx-001")).toMatchObject({ kind: "denied", code: "ALREADY_CANCELED" });
    expect(cancelTransfer(seed("a1-scheduled-standard"), "tx-999")).toMatchObject({
      kind: "denied",
      code: "TRANSFER_NOT_FOUND",
    });
  });

  it("does not mutate its input state", () => {
    const state = seed("a1-scheduled-standard");
    const snapshot = JSON.stringify(state);
    cancelTransfer(state, "tx-001");
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe("payment recovery (P4, P5)", () => {
  it("A3: accepts a complete request for a completed transfer", () => {
    const outcome = submitPaymentRecovery(seed("a3-completed-standard"), RECOVERY);
    expect(outcome).toMatchObject({ kind: "accepted", handling: "review" });
    if (outcome.kind === "accepted") expect(outcome.caseId).toBe("REC-100001");
  });

  it("P5: rejects a request missing the reference number or recipient information", () => {
    const state = seed("a3-completed-standard");
    for (const field of ["reference", "recipientName", "recipientBank", "recipientAccountLast4"] as const) {
      const outcome = submitPaymentRecovery(state, { ...RECOVERY, [field]: "" });
      expect(outcome.kind).toBe("invalid");
      if (outcome.kind === "invalid") expect(Object.keys(outcome.fieldErrors)).toContain(field);
    }
  });

  it("rejects details that do not match the transfer", () => {
    const state = seed("a3-completed-standard");
    expect(submitPaymentRecovery(state, { ...RECOVERY, reference: "NSM-0000-0000" })).toMatchObject({
      kind: "denied",
      code: "TRANSFER_NOT_MATCHED",
    });
    expect(submitPaymentRecovery(state, { ...RECOVERY, recipientAccountLast4: "0000" })).toMatchObject({
      kind: "denied",
      code: "TRANSFER_NOT_MATCHED",
    });
  });

  it("refuses recovery while the transfer has not completed", () => {
    for (const id of ["a1-scheduled-standard", "a2-scheduled-instant"] as const) {
      expect(submitPaymentRecovery(seed(id), RECOVERY)).toMatchObject({ kind: "denied", code: "NOT_COMPLETED_YET" });
    }
  });

  it("A2 replanning: recovery becomes available after the instant transfer completes", () => {
    const later = advanceClock(seed("a2-scheduled-instant"), 30 * MIN);
    expect(statusOf(later)).toBe("completed");
    expect(submitPaymentRecovery(later, RECOVERY).kind).toBe("accepted");
  });

  it("refuses recovery for a canceled transfer", () => {
    const canceled = cancelTransfer(seed("a1-scheduled-standard"), "tx-001");
    if (canceled.kind !== "canceled") throw new Error("expected cancel to succeed");
    expect(submitPaymentRecovery(canceled.state, RECOVERY)).toMatchObject({ kind: "denied", code: "TRANSFER_CANCELED" });
  });

  it("rejects duplicate requests", () => {
    const first = submitPaymentRecovery(seed("a3-completed-standard"), RECOVERY);
    if (first.kind !== "accepted") throw new Error("expected first request to be accepted");
    expect(submitPaymentRecovery(first.state, RECOVERY)).toMatchObject({ kind: "denied", code: "DUPLICATE_CASE" });
  });

  it("B3: the instant-transfer exception shortens the recovery window", () => {
    const state = seed("b3-instant-recovery-window");
    expect(statusOf(state)).toBe("completed");
    expect(submitPaymentRecovery(state, RECOVERY)).toMatchObject({ kind: "denied", code: "RECOVERY_WINDOW_EXPIRED" });
  });

  it("B3: standard transfers keep the general 60-day window", () => {
    const state = advanceClock(seed("b1-multiple-routes"), 7 * DAY);
    expect(submitPaymentRecovery(state, RECOVERY).kind).toBe("accepted");
    const tooLate = advanceClock(seed("b1-multiple-routes"), 60 * DAY);
    expect(submitPaymentRecovery(tooLate, RECOVERY)).toMatchObject({ kind: "denied", code: "RECOVERY_WINDOW_EXPIRED" });
  });

  it("basic edition has no recovery window", () => {
    const state = advanceClock(seed("a3-completed-standard"), 400 * DAY);
    expect(submitPaymentRecovery(state, RECOVERY).kind).toBe("accepted");
  });
});

describe("mistaken transfer report (P6)", () => {
  it("B1/B4: works without a reference number when date, amount and recipient contact are given", () => {
    const outcome = submitMistakenReport(seed("b4-reference-not-shown"), {
      ...MISTAKEN,
      transferDate: "2026-10-09",
      amount: "$850.00",
    });
    expect(outcome).toMatchObject({ kind: "accepted", handling: "review" });
  });

  it("requires either a reference or date plus amount plus recipient contact", () => {
    const outcome = submitMistakenReport(seed("b4-reference-not-shown"), MISTAKEN);
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") {
      expect(Object.keys(outcome.fieldErrors).sort()).toEqual(["amount", "transferDate"]);
    }
  });

  it("returns no match when date and amount do not identify a transfer", () => {
    expect(
      submitMistakenReport(seed("b4-reference-not-shown"), { ...MISTAKEN, transferDate: "2026-01-01", amount: "850" }),
    ).toMatchObject({ kind: "denied", code: "TRANSFER_NOT_MATCHED" });
  });

  it("refuses to treat a transfer the user did not start as mistaken", () => {
    expect(
      submitMistakenReport(seed("a3-completed-standard"), { ...MISTAKEN, initiatedByMe: "no", reference: "NSM-7Q4K-2R91" }),
    ).toMatchObject({ kind: "denied", code: "USE_UNAUTHORIZED_FORM" });
  });

  it("B3: after the instant window closes, a report is notification-only", () => {
    const outcome = submitMistakenReport(seed("b3-instant-recovery-window"), {
      ...MISTAKEN,
      reference: "NSM-7Q4K-2R91",
    });
    expect(outcome).toMatchObject({ kind: "accepted", handling: "outreach_only" });
  });

  it("requires the initiator question to be answered", () => {
    const outcome = submitMistakenReport(seed("a3-completed-standard"), { ...MISTAKEN, initiatedByMe: "" });
    expect(outcome).toMatchObject({ kind: "invalid" });
  });
});

describe("unauthorized transfer report (P6)", () => {
  it("accepts a report from a user who did not start the transfer", () => {
    const outcome = submitUnauthorizedReport(seed("a3-completed-standard"), UNAUTHORIZED);
    expect(outcome).toMatchObject({ kind: "accepted" });
    if (outcome.kind === "accepted") expect(outcome.caseId.startsWith("UNA-")).toBe(true);
  });

  it("refuses to treat a self-initiated transfer as unauthorized", () => {
    expect(submitUnauthorizedReport(seed("a3-completed-standard"), { ...UNAUTHORIZED, initiatedByMe: "yes" })).toMatchObject({
      kind: "denied",
      code: "USE_MISTAKEN_FORM",
    });
  });

  it("rejects a notice date in the future", () => {
    const outcome = submitUnauthorizedReport(seed("a3-completed-standard"), { ...UNAUTHORIZED, dateNoticed: "2026-12-31" });
    expect(outcome.kind).toBe("invalid");
    if (outcome.kind === "invalid") expect(Object.keys(outcome.fieldErrors)).toContain("dateNoticed");
  });
});

describe("formatting helpers", () => {
  it("parses amounts strictly", () => {
    expect(parseAmountToCents("850")).toBe(85_000);
    expect(parseAmountToCents("$1,250.5")).toBe(125_050);
    expect(parseAmountToCents("85o")).toBeNull();
    expect(parseAmountToCents("")).toBeNull();
    expect(formatMoney(85_000)).toBe("$850.00");
  });
});
