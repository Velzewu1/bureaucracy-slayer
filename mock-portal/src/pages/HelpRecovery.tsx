import { Link } from "react-router-dom";
import { Article } from "../components/Article";
import { RECOVERY_WINDOW_DAYS_GENERAL } from "../domain/rules";
import { getScenario } from "../domain/scenarios";
import { usePortalState } from "../domain/store";

export function HelpRecovery() {
  const state = usePortalState();
  const adversarial = getScenario(state.scenarioId).edition === "adversarial";

  return (
    <Article
      title="Recovering a completed transfer"
      lead="A completed transfer can't be canceled, but in some cases we can ask the recipient's bank to return the money."
    >
      <p>
        When a transfer has completed, the money is already in the recipient's account. We can't undo it directly. What we
        can do is submit a recovery request, which is separate from cancellation.
      </p>

      <h2>Is recovery guaranteed?</h2>
      <p>
        No. A completed transfer may be eligible for a recovery request, but the outcome depends on the recipient's bank
        and on the recipient. The money may already have been spent or moved. We'll email you the outcome of your
        request.
      </p>

      <h2>Which transfers are eligible</h2>
      <p>
        Completed transfers that you started yourself may be eligible. A transfer that is still scheduled or processing
        isn't eligible yet; if it can be canceled, cancel it instead. See{" "}
        <Link to="/help/transfers">Canceling a transfer</Link>.
      </p>
      {adversarial ? (
        <p>
          Recovery requests must be submitted within {RECOVERY_WINDOW_DAYS_GENERAL} days after the transfer completes,
          unless a rule for a specific transfer type says otherwise. Instant transfers have their own timing; see{" "}
          <Link to="/help/instant-transfers">Instant transfers</Link>.
        </p>
      ) : null}

      <h2>What you'll need</h2>
      <p>A recovery request requires:</p>
      <ul>
        <li>the transaction reference number, which appears on the transfer details page and in your confirmation email;</li>
        <li>the recipient's information: their full name, their bank, and the last four digits of their account number; and</li>
        <li>a short description of what happened and an email address where we can reach you.</li>
      </ul>
      <p>We can't open a recovery request without the reference number and the recipient's information.</p>

      <h2>How to submit a request</h2>
      <p>
        Complete the Payment recovery form on the <Link to="/support#payment-recovery">Support page</Link>.
      </p>

      <h2>Other ways to resolve a mistaken transfer</h2>
      <ul>
        <li>
          <strong>Report a mistaken transfer.</strong> If you don't have the reference number, or you only want us to
          notify the recipient's bank, use the Report a mistaken transfer form on the{" "}
          <Link to="/support#mistaken-transfer">Support page</Link>. It asks for the transfer date, amount and the
          recipient's contact details instead of a reference number. A report creates a record and starts outreach, but
          it isn't a recovery request and doesn't by itself return any money.
        </li>
        <li>
          <strong>Ask the recipient.</strong> You can contact the recipient yourself and ask them to send the money
          back, using contact details you already have. We can't do this on your behalf.
        </li>
      </ul>

      <h2>If you didn't make the transfer</h2>
      <p>
        A transfer that you didn't start or authorize is not a mistaken transfer. Don't use the recovery or mistaken
        transfer forms for it. Follow the separate process described in{" "}
        <Link to="/help/unauthorized-transfers">Unauthorized transfers</Link>.
      </p>
    </Article>
  );
}
