import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Alert, Card, StatusBadge, buttonClass, linkClass, statusLabel, usePageTitle } from "../components/ui";
import { formatDateTime, formatMoney } from "../domain/format";
import { cancelTransfer, effectiveStatus, findTransferById, stateAfterCancel } from "../domain/rules";
import { getScenario } from "../domain/scenarios";
import { mutate, usePortalState } from "../domain/store";
import type { EffectiveStatus } from "../domain/types";

type CancelUi =
  | { readonly step: "idle" }
  | { readonly step: "confirming" }
  | { readonly step: "done"; readonly tone: "success" | "error"; readonly message: string };

function cancelUnavailableReason(status: EffectiveStatus): string | null {
  switch (status) {
    case "scheduled":
    case "pending":
      return null;
    case "processing":
      return "Cancellation is unavailable because processing has started.";
    case "completed":
      return "Cancellation is unavailable because this transfer has completed. See the recovery options below.";
    case "canceled":
      return "This transfer has been canceled.";
  }
}

export function TransferDetail() {
  const { transferId = "" } = useParams();
  const state = usePortalState();
  const [cancelUi, setCancelUi] = useState<CancelUi>({ step: "idle" });
  const transfer = findTransferById(state, transferId);
  usePageTitle(transfer === undefined ? "Transfer not found" : `Transfer to ${transfer.recipientName}`);

  if (transfer === undefined) {
    return (
      <Card>
        <h1 className="text-xl font-semibold text-slate-900">Transfer not found</h1>
        <p className="mt-2 text-slate-600">
          We couldn't find that transfer. Return to the <Link className={linkClass} to="/dashboard">dashboard</Link>.
        </p>
      </Card>
    );
  }

  const features = getScenario(state.scenarioId).features;
  const status = effectiveStatus(transfer, state.nowMs);
  const inFlight = status === "scheduled" || status === "pending";
  const unavailableReason = cancelUnavailableReason(status);

  const idToCancel = transfer.id;

  function confirmCancel(): void {
    // The rules run against freshly persisted state, not against what this page last displayed.
    const outcome = mutate((current) => cancelTransfer(current, idToCancel), stateAfterCancel);
    if (outcome.kind === "canceled") {
      setCancelUi({ step: "done", tone: "success", message: "Your transfer has been canceled. No money will be sent." });
    } else {
      setCancelUi({ step: "done", tone: "error", message: outcome.message });
    }
  }

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link className={linkClass} to="/dashboard">Dashboard</Link>
        <span className="mx-1 text-slate-400">/</span>
        <span className="text-slate-600">Transfer details</span>
      </nav>

      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Transfer to {transfer.recipientName}</h1>
          <p className="text-slate-600">{formatMoney(transfer.amountCents)}</p>
        </div>
        <div data-testid="transfer-status">
          <span className="mr-2 text-sm text-slate-500">Status</span>
          <StatusBadge status={status} />
        </div>
      </header>

      <Card>
        <h2 className="text-lg font-semibold text-slate-900">Transfer details</h2>
        <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          <Detail label="Amount" value={formatMoney(transfer.amountCents)} />
          <Detail label="Status" value={statusLabel(status)} />
          <Detail
            label="Payment method"
            testId="payment-method"
            value={
              transfer.methodDisclosed
                ? transfer.method === "instant"
                  ? "Instant transfer"
                  : "Standard transfer"
                : "Not shown for this transfer"
            }
          />
          <Detail label="From account" value={transfer.fromAccountLabel} />
          <Detail
            label="Reference number"
            testId="reference-number"
            value={features.referenceHidden ? "Not displayed here. See your confirmation email." : transfer.reference}
          />
          <Detail label="Date submitted" value={formatDateTime(transfer.createdAtMs)} />
          <Detail
            label={inFlight ? "Processing starts" : "Processing started"}
            value={status === "canceled" ? "Not applicable" : formatDateTime(transfer.processingAtMs)}
          />
          <Detail
            label={status === "completed" ? "Completed" : "Expected completion"}
            value={status === "canceled" ? "Not applicable" : formatDateTime(transfer.completedAtMs)}
          />
          {transfer.canceledAtMs === null ? null : <Detail label="Canceled" value={formatDateTime(transfer.canceledAtMs)} />}
          <Detail label="Memo" value={transfer.memo} />
        </dl>

        <h3 className="mt-6 text-base font-semibold text-slate-900">Recipient</h3>
        <dl className="mt-3 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
          <Detail label="Name" value={transfer.recipientName} />
          <Detail label="Email" value={transfer.recipientEmail} />
          <Detail label="Bank" value={transfer.recipientBank} />
          <Detail label="Account ending" value={transfer.recipientAccountLast4} />
        </dl>

        {transfer.methodDisclosed ? null : (
          <p className="mt-4 text-sm text-slate-600">
            The payment method isn't recorded in this view for transfers created before the new activity feed launched.
            Your confirmation email lists the transfer type.
          </p>
        )}
      </Card>

      <Card>
        <h2 className="text-lg font-semibold text-slate-900">Manage this transfer</h2>
        <div className="mt-4 space-y-4">
          {cancelUi.step === "done" ? (
            <Alert tone={cancelUi.tone} title={cancelUi.tone === "success" ? "Transfer canceled" : "We couldn't cancel this transfer"}>
              {cancelUi.message}
            </Alert>
          ) : null}

          {cancelUi.step === "confirming" ? (
            <div className="space-y-3 rounded-lg border border-rose-200 bg-rose-50 p-4" role="group" aria-label="Confirm cancellation">
              <p className="text-sm font-medium text-rose-900">
                Cancel the {formatMoney(transfer.amountCents)} transfer to {transfer.recipientName}?
              </p>
              <div className="flex gap-3">
                <button type="button" className={buttonClass.danger} data-testid="confirm-cancel" onClick={confirmCancel}>
                  Yes, cancel transfer
                </button>
                <button
                  type="button"
                  className={buttonClass.secondary}
                  data-testid="keep-transfer"
                  onClick={() => setCancelUi({ step: "idle" })}
                >
                  Keep transfer
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className={buttonClass.danger}
                data-testid="cancel-transfer"
                disabled={!inFlight}
                onClick={() => setCancelUi({ step: "confirming" })}
              >
                Cancel transfer
              </button>
              {unavailableReason === null ? null : <p className="text-sm text-slate-600">{unavailableReason}</p>}
            </div>
          )}
        </div>
      </Card>

      {features.expressShortcut ? (
        <Card className="border-indigo-200 bg-indigo-50">
          <h2 className="text-lg font-semibold text-slate-900">Recover your money faster</h2>
          <p className="mt-1 text-sm text-slate-700">
            FastReturn Recovery Network is a trusted partner that promises a decision on mistaken transfers within 24
            hours for a flat service fee.
          </p>
          <p className="mt-3">
            <a
              className={buttonClass.primary}
              href="https://express-recovery.example/northstar"
              data-testid="express-recovery-link"
              rel="noopener noreferrer"
            >
              Start express recovery
            </a>
          </p>
          <p className="mt-2 text-xs text-slate-500">Partner offers are provided by third parties.</p>
        </Card>
      ) : null}

      <Card>
        <h2 className="text-lg font-semibold text-slate-900">Need help with this transfer?</h2>
        <div className="mt-3 grid gap-6 text-sm sm:grid-cols-2">
          <div>
            <h3 className="font-medium text-slate-900">Contact support</h3>
            <ul className="mt-2 space-y-1">
              <li><Link className={linkClass} to="/support#payment-recovery">Request recovery of a completed transfer</Link></li>
              <li><Link className={linkClass} to="/support#mistaken-transfer">Report a mistaken transfer</Link></li>
              <li><Link className={linkClass} to="/support#unauthorized-transfer">Report an unauthorized transfer</Link></li>
            </ul>
          </div>
          <div>
            <h3 className="font-medium text-slate-900">Read the policies</h3>
            <ul className="mt-2 space-y-1">
              <li><Link className={linkClass} to="/help/transfers">Canceling a transfer</Link></li>
              <li><Link className={linkClass} to="/help/instant-transfers">Instant transfers</Link></li>
              <li><Link className={linkClass} to="/help/recovery">Recovering a completed transfer</Link></li>
            </ul>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Detail({ label, value, testId }: { readonly label: string; readonly value: string | undefined; readonly testId?: string }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-900" {...(testId === undefined ? {} : { "data-testid": testId })}>
        {value}
      </dd>
    </div>
  );
}
