import { Link } from "react-router-dom";
import { Article } from "../components/Article";
import { getScenario } from "../domain/scenarios";
import { usePortalState } from "../domain/store";

export function HelpFaq() {
  const state = usePortalState();
  const conflicting = getScenario(state.scenarioId).features.conflictingFaq;

  return (
    <Article
      title="Frequently asked questions"
      lead="Quick answers to common questions about transfers."
      reviewed={conflicting ? "Last reviewed March 12, 2023" : "Last reviewed October 1, 2026"}
    >
      <h2>How long does a standard transfer take?</h2>
      <p>
        Standard transfers begin processing at the time shown on the transfer details page and usually complete within
        two business days.
      </p>

      <h2>Can I cancel a transfer?</h2>
      <p>
        A scheduled standard transfer can be canceled before processing begins. See{" "}
        <Link to="/help/transfers">Canceling a transfer</Link> for details.
      </p>

      <h2>Can I cancel an instant transfer?</h2>
      {conflicting ? (
        <p>
          Yes. If you notice a mistake right away, you can cancel an instant transfer from its transfer details page
          while its status still shows Scheduled or Pending. The cancellation window is described in your transfer
          agreement.
        </p>
      ) : (
        <p>
          No. Instant transfers can't be canceled once submitted. See{" "}
          <Link to="/help/instant-transfers">Instant transfers</Link>.
        </p>
      )}

      <h2>What if I sent money to the wrong person?</h2>
      <p>
        If the transfer has already completed, see <Link to="/help/recovery">Recovering a completed transfer</Link>.
      </p>

      <h2>Is Northstar Mock Bank a real bank?</h2>
      <p>No. It is a fictional bank used only to test software. No real money or real accounts are involved.</p>
    </Article>
  );
}
