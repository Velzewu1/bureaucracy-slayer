// Domain types for the Northstar Mock Bank simulation.
// This module is intentionally independent of React and of any Bureaucracy Slayer code.

export type TransferMethod = "standard" | "instant";

/** Status stored on the transfer record. Time-based transitions are derived, see `effectiveStatus`. */
export type StoredStatus = "scheduled" | "pending" | "canceled";

/** Status the portal shows and enforces at a given moment. */
export type EffectiveStatus = "scheduled" | "pending" | "processing" | "completed" | "canceled";

/** `basic` carries policies P1-P8 only. `adversarial` adds timing windows, alternate routes and noisier content. */
export type Edition = "basic" | "adversarial";

export interface Features {
  /** An older FAQ article contradicts the instant-transfer exception. */
  readonly conflictingFaq: boolean;
  /** The transfer details page does not display the reference number (it was only emailed). */
  readonly referenceHidden: boolean;
  /** The transfer details page promotes a third-party "express recovery" destination. */
  readonly expressShortcut: boolean;
}

export interface Transfer {
  readonly id: string;
  readonly reference: string;
  readonly amountCents: number;
  readonly recipientName: string;
  readonly recipientEmail: string;
  readonly recipientBank: string;
  readonly recipientAccountLast4: string;
  readonly fromAccountLabel: string;
  readonly memo: string;
  /** Authoritative method. Enforcement uses this even when the page does not display it. */
  readonly method: TransferMethod;
  readonly storedStatus: StoredStatus;
  readonly createdAtMs: number;
  readonly processingAtMs: number;
  readonly completedAtMs: number;
  readonly canceledAtMs: number | null;
  /** Whether the transfer details page shows the method. */
  readonly methodDisclosed: boolean;
}

export type CaseKind = "payment_recovery" | "mistaken_transfer" | "unauthorized_transfer";

export interface SupportCase {
  readonly id: string;
  readonly kind: CaseKind;
  readonly transferId: string;
  readonly createdAtMs: number;
  /** `review` is the normal path. `outreach_only` means no funds can be requested back. */
  readonly handling: "review" | "outreach_only";
}

export const SCENARIO_IDS = [
  "a1-scheduled-standard",
  "a2-scheduled-instant",
  "a3-completed-standard",
  "a4-unknown-method-standard",
  "a4-unknown-method-instant",
  "b1-multiple-routes",
  "b3-instant-recovery-window",
  "b4-reference-not-shown",
  "b5-conflicting-policy",
  "b6-express-shortcut",
  "b7-state-change",
] as const;

export type ScenarioId = (typeof SCENARIO_IDS)[number];

export interface Scenario {
  readonly id: ScenarioId;
  readonly mode: "A" | "B";
  readonly title: string;
  readonly summary: string;
  readonly edition: Edition;
  readonly features: Features;
  readonly transfer: Transfer;
}

/** The only mutable state. Persisted in localStorage and mutated only through `rules.ts`. */
export interface PortalState {
  readonly schemaVersion: 1;
  readonly scenarioId: ScenarioId;
  readonly nowMs: number;
  /** Cancellation timestamps keyed by transfer id. */
  readonly canceledAtMs: Readonly<Record<string, number>>;
  readonly cases: readonly SupportCase[];
}

export function isScenarioId(value: unknown): value is ScenarioId {
  return typeof value === "string" && (SCENARIO_IDS as readonly string[]).includes(value);
}
