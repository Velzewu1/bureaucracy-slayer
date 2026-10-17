import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  Alert,
  Card,
  CheckboxField,
  RadioGroup,
  SelectField,
  TextAreaField,
  TextField,
  buttonClass,
  linkClass,
  readChecked,
  readString,
  usePageTitle,
} from "../components/ui";
import {
  submitMistakenReport,
  submitPaymentRecovery,
  submitUnauthorizedReport,
  stateAfterForm,
} from "../domain/rules";
import type { FieldErrors, FormOutcome } from "../domain/rules";
import { mutate } from "../domain/store";

type FormResult = FormOutcome | null;

const ISSUE_OPTIONS = [
  { value: "wrong_recipient", label: "I sent it to the wrong recipient" },
  { value: "wrong_amount", label: "I sent the wrong amount" },
  { value: "duplicate_payment", label: "I sent the payment twice" },
] as const;

const YES_NO = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
] as const;

export function Support() {
  usePageTitle("Support");
  const location = useLocation();

  useEffect(() => {
    if (location.hash.length > 1) {
      document.getElementById(location.hash.slice(1))?.scrollIntoView();
    }
  }, [location.hash]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Support</h1>
        <p className="text-slate-600">
          Choose the form that matches your situation. Required fields are marked with an asterisk (*).
        </p>
      </header>

      <Card>
        <h2 className="text-lg font-semibold text-slate-900">Which form should I use?</h2>
        <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-slate-700">
          <li>
            <strong>Payment recovery:</strong> a transfer that has already completed and that you started yourself. See{" "}
            <Link className={linkClass} to="/help/recovery">Recovering a completed transfer</Link>.
          </li>
          <li>
            <strong>Mistaken transfer:</strong> you started the transfer but sent it to the wrong recipient or for the
            wrong amount.
          </li>
          <li>
            <strong>Unauthorized transfer:</strong> you did not start the transfer. See{" "}
            <Link className={linkClass} to="/help/unauthorized-transfers">Unauthorized transfers</Link>.
          </li>
        </ul>
        <p className="mt-4 text-sm text-slate-600">
          You can also reach us by phone at 1-800-555-0142 (a fictional number), 8 a.m. to 8 p.m. ET, or by email at
          support@northstar-mock.example. Do not send passwords or full account numbers.
        </p>
      </Card>

      <PaymentRecoveryForm />
      <MistakenTransferForm />
      <UnauthorizedTransferForm />
    </div>
  );
}

// --- Shared form chrome -----------------------------------------------------------

function FormCard({
  id,
  title,
  intro,
  result,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly intro: string;
  readonly result: FormResult;
  readonly children: ReactNode;
}) {
  return (
    <Card>
      <div id={id} />
      <h2 id={`${id}-heading`} className="text-xl font-semibold text-slate-900">{title}</h2>
      <p className="mt-1 text-sm text-slate-600">{intro}</p>
      <div className="mt-4 space-y-4">
        <ResultBanner result={result} />
        {children}
      </div>
    </Card>
  );
}

function ResultBanner({ result }: { readonly result: FormResult }) {
  if (result === null) return null;
  switch (result.kind) {
    case "invalid":
      return <Alert tone="error" title="Please correct the highlighted fields.">Some required information is missing or invalid.</Alert>;
    case "denied":
      return <Alert tone="error" title="We couldn't submit this request">{result.message}</Alert>;
    case "accepted":
      return (
        <Alert tone="success" title="Request received">
          Case number <strong data-testid="case-id">{result.caseId}</strong>. {result.message}
        </Alert>
      );
  }
}

function errorsOf(result: FormResult): FieldErrors {
  return result?.kind === "invalid" ? result.fieldErrors : {};
}

function useFormSubmit(run: (data: FormData) => FormOutcome) {
  const [result, setResult] = useState<FormResult>(null);
  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    const outcome = run(new FormData(form));
    setResult(outcome);
    if (outcome.kind === "accepted") form.reset();
  }
  return { result, onSubmit };
}

// --- Payment recovery (completed transfers) ---------------------------------------------

function PaymentRecoveryForm() {
  const { result, onSubmit } = useFormSubmit((data) =>
    mutate((state) =>
      submitPaymentRecovery(state, {
        reference: readString(data, "reference"),
        recipientName: readString(data, "recipientName"),
        recipientBank: readString(data, "recipientBank"),
        recipientAccountLast4: readString(data, "recipientAccountLast4"),
        reason: readString(data, "reason"),
        details: readString(data, "details"),
        contactEmail: readString(data, "contactEmail"),
        confirmAccurate: readChecked(data, "confirmAccurate"),
      }),
    stateAfterForm,
    ),
  );
  const errors = errorsOf(result);

  return (
    <FormCard
      id="payment-recovery"
      title="Payment recovery request"
      intro="Ask us to try to recover money from a completed transfer. Recovery is not guaranteed."
      result={result}
    >
      <form aria-labelledby="payment-recovery-heading" noValidate onSubmit={onSubmit} className="space-y-4">
        <TextField id="pr-reference" name="reference" label="Transaction reference number" required error={errors["reference"]} />
        <TextField id="pr-recipient-name" name="recipientName" label="Recipient's full name" required error={errors["recipientName"]} />
        <TextField id="pr-recipient-bank" name="recipientBank" label="Recipient's bank or credit union" required error={errors["recipientBank"]} />
        <TextField id="pr-recipient-last4" name="recipientAccountLast4" label="Last four digits of recipient's account" required error={errors["recipientAccountLast4"]} />
        <SelectField
          id="pr-reason"
          name="reason"
          label="Reason for the request"
          required
          error={errors["reason"]}
          options={ISSUE_OPTIONS}
        />
        <TextAreaField id="pr-details" name="details" label="What happened?" required error={errors["details"]} />
        <TextField id="pr-contact-email" name="contactEmail" type="email" autoComplete="email" label="Your email address" required error={errors["contactEmail"]} />
        <CheckboxField id="pr-confirm" name="confirmAccurate" label="I confirm that the information above is accurate and that I started this transfer myself." error={errors["confirmAccurate"]} />
        <button type="submit" className={buttonClass.primary}>Submit recovery request</button>
      </form>
    </FormCard>
  );
}

// --- Mistaken transfer report -------------------------------------------------------------

function MistakenTransferForm() {
  const { result, onSubmit } = useFormSubmit((data) =>
    mutate((state) =>
      submitMistakenReport(state, {
        initiatedByMe: readString(data, "initiatedByMe"),
        reference: readString(data, "reference"),
        transferDate: readString(data, "transferDate"),
        amount: readString(data, "amount"),
        recipientName: readString(data, "recipientName"),
        recipientContact: readString(data, "recipientContact"),
        issueType: readString(data, "issueType"),
        details: readString(data, "details"),
        contactEmail: readString(data, "contactEmail"),
        confirmAccurate: readChecked(data, "confirmAccurate"),
      }),
    stateAfterForm,
    ),
  );
  const errors = errorsOf(result);

  return (
    <FormCard
      id="mistaken-transfer"
      title="Report a mistaken transfer"
      intro="Tell us about a transfer you started by mistake. A report creates a record and starts outreach; it is not a recovery request."
      result={result}
    >
      <form aria-labelledby="mistaken-transfer-heading" noValidate onSubmit={onSubmit} className="space-y-4">
        <RadioGroup id="mt-initiated" name="initiatedByMe" legend="Did you start this transfer yourself?" options={YES_NO} error={errors["initiatedByMe"]} />
        <TextField
          id="mt-reference"
          name="reference"
          label="Transaction reference number"
          hint="Optional. If you don't have it, enter the transfer date and amount below."
          error={errors["reference"]}
        />
        <TextField id="mt-date" name="transferDate" type="date" label="Transfer date" hint="Required if you don't enter a reference number." error={errors["transferDate"]} />
        <TextField id="mt-amount" name="amount" label="Transfer amount (USD)" hint="Required if you don't enter a reference number." error={errors["amount"]} />
        <TextField id="mt-recipient-name" name="recipientName" label="Recipient's name" required error={errors["recipientName"]} />
        <TextField
          id="mt-recipient-contact"
          name="recipientContact"
          label="Recipient's email or phone number"
          hint="Required if you don't enter a reference number."
          error={errors["recipientContact"]}
        />
        <SelectField id="mt-issue" name="issueType" label="What went wrong?" required error={errors["issueType"]} options={ISSUE_OPTIONS} />
        <TextAreaField id="mt-details" name="details" label="What happened?" required error={errors["details"]} />
        <TextField id="mt-contact-email" name="contactEmail" type="email" autoComplete="email" label="Your email address" required error={errors["contactEmail"]} />
        <CheckboxField id="mt-confirm" name="confirmAccurate" label="I confirm that the information above is accurate." error={errors["confirmAccurate"]} />
        <button type="submit" className={buttonClass.primary}>Submit mistaken transfer report</button>
      </form>
    </FormCard>
  );
}

// --- Unauthorized transfer report ---------------------------------------------------------

function UnauthorizedTransferForm() {
  const { result, onSubmit } = useFormSubmit((data) =>
    mutate((state) =>
      submitUnauthorizedReport(state, {
        initiatedByMe: readString(data, "initiatedByMe"),
        reference: readString(data, "reference"),
        transferDate: readString(data, "transferDate"),
        amount: readString(data, "amount"),
        dateNoticed: readString(data, "dateNoticed"),
        accountSecured: readString(data, "accountSecured"),
        details: readString(data, "details"),
        contactEmail: readString(data, "contactEmail"),
        confirmAccurate: readChecked(data, "confirmAccurate"),
      }),
    stateAfterForm,
    ),
  );
  const errors = errorsOf(result);

  return (
    <FormCard
      id="unauthorized-transfer"
      title="Report an unauthorized transfer"
      intro="Use this only for a transfer you did not start and did not give anyone permission to start."
      result={result}
    >
      <form aria-labelledby="unauthorized-transfer-heading" noValidate onSubmit={onSubmit} className="space-y-4">
        <RadioGroup id="ut-initiated" name="initiatedByMe" legend="Did you start this transfer yourself?" options={YES_NO} error={errors["initiatedByMe"]} />
        <TextField
          id="ut-reference"
          name="reference"
          label="Transaction reference number"
          hint="Optional. If you don't have it, enter the transfer date and amount below."
          error={errors["reference"]}
        />
        <TextField id="ut-date" name="transferDate" type="date" label="Transfer date" hint="Required if you don't enter a reference number." error={errors["transferDate"]} />
        <TextField id="ut-amount" name="amount" label="Transfer amount (USD)" hint="Required if you don't enter a reference number." error={errors["amount"]} />
        <TextField id="ut-date-noticed" name="dateNoticed" type="date" label="Date you first noticed the transfer" required error={errors["dateNoticed"]} />
        <RadioGroup id="ut-secured" name="accountSecured" legend="Have you secured your account (for example, changed your password)?" options={YES_NO} error={errors["accountSecured"]} />
        <TextAreaField id="ut-details" name="details" label="What happened?" required error={errors["details"]} />
        <TextField id="ut-contact-email" name="contactEmail" type="email" autoComplete="email" label="Your email address" required error={errors["contactEmail"]} />
        <CheckboxField id="ut-confirm" name="confirmAccurate" label="I confirm that the information above is accurate and that I did not start or authorize this transfer." error={errors["confirmAccurate"]} />
        <button type="submit" className={buttonClass.primary}>Submit unauthorized transfer report</button>
      </form>
    </FormCard>
  );
}
