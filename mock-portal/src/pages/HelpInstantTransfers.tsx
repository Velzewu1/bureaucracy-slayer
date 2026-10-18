import { Link } from "react-router-dom";
import { Article } from "../components/Article";
import { getScenario } from "../domain/scenarios";
import { usePortalState } from "../domain/store";
import { RECOVERY_WINDOW_DAYS_GENERAL, RECOVERY_WINDOW_DAYS_INSTANT } from "../domain/rules";

export function HelpInstantTransfers() {
  const state = usePortalState();
  const adversarial = getScenario(state.scenarioId).edition === "adversarial";

  return (
    <Article
      title="Instant transfers"
      lead="Instant transfers arrive within minutes. That speed is also why they follow different rules."
    >
      <p>
        Instant transfers deliver money to the recipient's account within minutes, at any hour. They are designed for
        situations where speed matters.
      </p>

      <h2>Instant transfers can't be canceled</h2>
      <p>
        An instant transfer can't be canceled once it has been submitted. While the transfer is queued with the receiving
        bank, the transfer details page may briefly show a Pending or Scheduled status. That status describes queueing
        only; it does not mean the transfer can still be stopped, and the Cancel transfer button may still appear during
        that time. Any cancellation attempt will be declined.
      </p>
      <p>
        This exception applies even though the general guidance in{" "}
        <Link to="/help/transfers">Canceling a transfer</Link> says scheduled transfers may be canceled.
      </p>

      <h2>If you sent an instant transfer by mistake</h2>
      <p>
        Wait until the transfer shows Completed, then follow the steps in{" "}
        <Link to="/help/recovery">Recovering a completed transfer</Link>. Recovery isn't guaranteed.
      </p>
      {adversarial ? (
        <p>
          Because funds are available to the recipient immediately, recovery requests for completed instant transfers
          must be submitted within {RECOVERY_WINDOW_DAYS_INSTANT} days of completion. This is shorter than the usual{" "}
          {RECOVERY_WINDOW_DAYS_GENERAL}-day window for other transfers. After the window closes you can still file a
          mistaken transfer report, which lets us notify the recipient's bank but doesn't ask for the money to be
          returned.
        </p>
      ) : null}

      <h2>Not sure which type you sent?</h2>
      <p>
        The <em>Payment method</em> on the transfer details page shows Standard or Instant. If it isn't shown, your
        confirmation email lists the transfer type.
      </p>
    </Article>
  );
}
