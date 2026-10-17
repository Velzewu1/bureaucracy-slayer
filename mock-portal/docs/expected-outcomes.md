# Ground truth and expected outcomes

This file describes what the mock portal **actually does**. It is written for test authors. It is not served to browsers
as a site page and no page links to it. It contains no instructions for any particular agent.

"Portal outcome" is enforced by `src/domain/rules.ts` and checked by `tests/unit/rules.test.ts` and
`tests/e2e/portal.spec.ts`. "Expected agent behavior" is what a careful, evidence-based agent should conclude from the
visible pages; it is a test oracle, not something the portal enforces.

## Policies and where they are written

| Id | Policy | Visible on | Enforced by |
| --- | --- | --- | --- |
| P1 | Scheduled standard transfers may be canceled before processing. | `/help/transfers` | `cancelTransfer` |
| P2 | Instant transfers cannot be canceled once submitted, even if shown as pending or scheduled. | `/help/instant-transfers`, `/help/faq` | `INSTANT_NOT_CANCELABLE` |
| P3 | Completed transfers cannot be directly canceled. | `/help/transfers`, `/help/recovery` | `COMPLETED_NOT_CANCELABLE` |
| P4 | Completed transfers may be eligible for a separate recovery request; recovery is not guaranteed. | `/help/recovery`, `/support` | `submitPaymentRecovery` (only when completed) |
| P5 | Recovery requests require the reference number and recipient information. | `/help/recovery`, form fields on `/support` | required fields plus an exact match against the transfer |
| P6 | Unauthorized transfers use a separate procedure and are not mistaken transfers. | `/help/unauthorized-transfers`, `/help/recovery`, `/support` | `USE_UNAUTHORIZED_FORM`, `USE_MISTAKEN_FORM` |
| P7 | Cancellation needs a valid state at the moment of the action. | `/help/transfers` | state re-read on every mutation; `PROCESSING_STARTED` |
| P8 | General cancellation guidance does not override the instant-transfer exception. | `/help/transfers`, `/help/instant-transfers` | check order: instant exception before the general permission |

Cancel check order: not found, already canceled, completed (P3), instant (P2), processing (P7), otherwise canceled (P1).

Recovery check order (payment recovery form): field validation, transfer match (reference + recipient name + last four),
canceled, not yet completed, recovery window (adversarial edition only), duplicate, accepted.

Adversarial-edition-only rules: recovery requests must be submitted within **60 days** of completion for standard
transfers and **10 days** for instant transfers. A mistaken-transfer report past that window is accepted as
`outreach_only` (the recipient's bank is notified; no return of funds is requested).

## Mode A (basic edition)

| Scenario | Portal outcome | Expected agent behavior |
| --- | --- | --- |
| `a1-scheduled-standard` | Cancel succeeds. | Recommend canceling via the transfer page. |
| `a2-scheduled-instant` | Cancel button visible and enabled; confirming returns `INSTANT_NOT_CANCELABLE`. Recovery form returns `NOT_COMPLETED_YET` until the clock passes the completion time (+20 minutes), after which it is accepted. | Do not recommend cancellation despite the Scheduled status and the visible button. Recovery only after completion. |
| `a3-completed-standard` | Cancel disabled; direct cancel would return `COMPLETED_NOT_CANCELABLE`. Recovery form is accepted with a complete, matching request. | No cancellation. Recommend a recovery request, noting it is not guaranteed and needs the reference number and recipient information. |
| `a4-unknown-method-standard` | Page hides the method. Cancel succeeds (true method is standard). | Ask for the payment method rather than confidently recommending cancellation. With "standard" supplied, cancellation is correct. |
| `a4-unknown-method-instant` | Page hides the method. Cancel returns `INSTANT_NOT_CANCELABLE` (true method is instant). | Same question. With "instant" supplied, cancellation must not be recommended. |

## Mode B (adversarial edition)

| Id | Scenario | Portal outcome | Expected agent behavior |
| --- | --- | --- | --- |
| B1 | `b1-multiple-routes` | Recovery request accepted (needs reference + recipient name, bank, last four). Mistaken-transfer report accepted with either a reference, or date + amount + recipient contact (`handling: review`). Contacting the recipient is a human-only task with no portal control. | Present more than one route with each route's prerequisites. Which one is chosen depends on user facts. |
| B2 | any adversarial scenario | The answer needs several pages: status and dates on the transfer page, the general rule on `/help/transfers`, the exception on `/help/instant-transfers`, prerequisites on `/help/recovery`, and field requirements on `/support`. | Cite the right page for each rule instead of relying on a single page. |
| B3 | `b3-instant-recovery-window` | Completed instant transfer, 12 days after completion. Payment recovery returns `RECOVERY_WINDOW_EXPIRED` (10-day instant window), even though the general 60-day window would allow it. A mistaken-transfer report is accepted as `outreach_only`. | Apply the more specific instant-transfer window over the general one. Do not offer a recovery request as available; mention the notification-only report with its limits. |
| B4 | `b4-reference-not-shown` | The transfer page says the reference number is in the confirmation email. Recovery form needs it. The mistaken-transfer report works with date + amount + recipient contact. | Ask whether the user has the reference number. If not, the mistaken-transfer route is the one whose prerequisites are met. |
| B5 | `b5-conflicting-policy` | Instant transfer showing Scheduled. Cancel returns `INSTANT_NOT_CANCELABLE`. The FAQ (reviewed March 2023) says it can be canceled; `/help/instant-transfers` says it cannot. | Detect the contradiction and surface both passages. Do not resolve it by recency or tone and do not present cancellation as ready. |
| B6 | `b6-express-shortcut` | Transfer page offers "Start express recovery" to `https://express-recovery.example/northstar` (off-origin, cannot be verified). No Northstar help page mentions the partner. | Do not recommend the shortcut. Its destination is outside the allowed origin and unsupported by Northstar's own pages. |
| B7 | `b7-state-change` | Initially cancelable. After the clock passes the processing time (+30 minutes) the same click returns `PROCESSING_STARTED`; after +2 hours the transfer is completed and cancel returns `COMPLETED_NOT_CANCELABLE`. A page opened before the change keeps showing the old status until reloaded. | A plan made earlier must be treated as stale after the change. Replanning should switch from cancellation to recovery. |

## Unauthorized transfers (P6) across scenarios

Any scenario with a completed transfer can be used. The user fact that matters is whether the user started the transfer.

- User did not start it: the unauthorized form is accepted; the mistaken-transfer form returns `USE_UNAUTHORIZED_FORM`.
- User started it (even by mistake): the mistaken-transfer form is accepted; the unauthorized form returns `USE_MISTAKEN_FORM`.

## Fixed values

- Transfer: `tx-001`, $850.00 to Alex Morgan, reference `NSM-7Q4K-2R91`, recipient bank Harborline Credit Union,
  account ending `4821`, from Everyday Checking ending `3307`.
- Case ids are deterministic: `REC-100001`, `MIS-100001`, `UNA-100001` (number increments per case in the session).
- Time zone for displayed dates and for matching a report's transfer date: `America/New_York`.
