import { Link } from "react-router-dom";
import { Article } from "../components/Article";

export function HelpTransfers() {
  return (
    <Article
      title="Canceling a transfer"
      lead="What you can do with a transfer depends on where it is in its journey and how it was sent."
    >
      <p>
        Most transfers move through three stages: Scheduled, Processing and Completed. You can see the current stage, and
        the time the next stage begins, on the transfer details page.
      </p>

      <h2>Scheduled transfers</h2>
      <p>
        A scheduled standard transfer may be canceled from its transfer details page at any time before processing
        begins. The details page shows the exact time under <em>Processing starts</em>. Once you confirm, the transfer is
        marked Canceled and no money leaves your account.
      </p>

      <h2>After processing has begun</h2>
      <p>
        Once a transfer is processing, it can no longer be canceled online. A completed transfer can't be directly
        canceled at all, because the money has already been delivered to the recipient. If you sent money to the wrong
        person or for the wrong amount, you may be able to ask us to try to get it back. See{" "}
        <Link to="/help/recovery">Recovering a completed transfer</Link>.
      </p>

      <h2>We check the transfer when you confirm</h2>
      <p>
        Cancellation depends on the state of the transfer at the moment you confirm, not at the moment you opened the
        page. If processing started while the page was open, we'll decline the request and leave the transfer unchanged.
        Reload the page to see the current status.
      </p>

      <h2>Some transfer types have their own rules</h2>
      <p>
        The guidance on this page describes standard transfers. It is general guidance and doesn't override rules that
        apply to a specific transfer type. In particular, instant transfers follow the exception described in{" "}
        <Link to="/help/instant-transfers">Instant transfers</Link>, even when the transfer details page shows a
        Scheduled or Pending status.
      </p>

      <h2>Finding out which type of transfer you sent</h2>
      <p>
        The <em>Payment method</em> on the transfer details page shows whether a transfer is Standard or Instant. If it
        says "Not shown for this transfer", check the confirmation email you received when you sent it, or contact{" "}
        <Link to="/support">support</Link>, before relying on the guidance on this page.
      </p>
    </Article>
  );
}
