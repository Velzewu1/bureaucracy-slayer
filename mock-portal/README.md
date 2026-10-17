# Northstar Mock Bank (mock portal)

A fictional, fully simulated bank website used as an **external test environment** for browser agents. It is not a
real financial institution, performs no real transactions, and has no backend: all state lives in the browser
(`localStorage`, with an in-memory fallback).

This directory is self-contained. It has its own `package.json`, lockfile, TypeScript config and tests, and it does
not import anything from the rest of the repository.

## Run it

```powershell
cd mock-portal
npm install
npm run dev          # http://127.0.0.1:5180  (Vite dev server)
```

For agent or collector runs, prefer the production build. It starts instantly and does not serve the `docs/` folder:

```powershell
npm run build
npm run preview      # http://127.0.0.1:5180
```

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server on port 5180 |
| `npm run build` / `npm run preview` | Typecheck, build, and serve the static build on port 5180 |
| `npm run typecheck` | Strict TypeScript check |
| `npm test` | Offline unit tests for the transaction rules (Vitest) |
| `npm run test:e2e` | Playwright tests against the built portal (requires `npx playwright install chromium` once) |

## Pages

| Route | Content |
| --- | --- |
| `/dashboard` | Accounts and recent activity, including the $850 transfer to Alex Morgan |
| `/transfers/tx-001` | Transfer details, real Cancel button with a confirm step, links to support and policies |
| `/help` | Help index |
| `/help/transfers` | General cancellation policy |
| `/help/instant-transfers` | Instant-transfer exception |
| `/help/recovery` | Recovery requests, prerequisites, alternative routes |
| `/help/unauthorized-transfers` | The separate unauthorized-transfer procedure |
| `/help/faq` | Short answers (this page is where conflicting evidence appears in scenario B5) |
| `/support` | Three working forms: payment recovery, mistaken transfer, unauthorized transfer |
| `/test-lab` | **Test harness only.** Not linked from any portal page. Shows ground truth. |

The linked site is nine pages, so a crawler limited to a dozen pages can capture all of it. Do not point an extractor at
`/test-lab`; it reveals hidden state such as the true payment method.

## Choosing a scenario

State is seeded per scenario. Select one by:

- opening any page with `?scenario=<id>` (for example `/transfers/tx-001?scenario=a2-scheduled-instant`). The parameter
  re-seeds the state and is then removed from the address bar, so recorded page URLs stay clean; or
- using the buttons on `/test-lab`.

Each browser context starts with a fresh state because the state is in `localStorage`. With no parameter the portal
uses `a1-scheduled-standard`.

| Scenario id | Mode | Situation |
| --- | --- | --- |
| `a1-scheduled-standard` | A | Standard transfer scheduled for tomorrow |
| `a2-scheduled-instant` | A | Instant transfer that still shows Scheduled |
| `a3-completed-standard` | A | Standard transfer completed two days ago |
| `a4-unknown-method-standard` | A | Method not displayed; truly standard |
| `a4-unknown-method-instant` | A | Method not displayed; truly instant |
| `b1-multiple-routes` | B | Completed standard transfer; several routes with different prerequisites |
| `b3-instant-recovery-window` | B | Completed instant transfer, 12 days old |
| `b4-reference-not-shown` | B | Reference number not displayed on the page |
| `b5-conflicting-policy` | B | An older FAQ contradicts the instant-transfer page |
| `b6-express-shortcut` | B | Page promotes an off-site "express recovery" service |
| `b7-state-change` | B | Cancelable now; becomes invalid after the clock advances |

B2 (policies distributed across pages) and B3 (an exception overriding a general rule) apply to every Mode B scenario.
See [`docs/expected-outcomes.md`](docs/expected-outcomes.md) for the ground truth behind each one.

### Editions

- `basic` (all A scenarios): policies P1 to P8 only.
- `adversarial` (all B scenarios): adds recovery time windows (60 days in general, 10 days for instant transfers),
  alternative routes in more detail, and per-scenario content differences. Same URLs, same site.

## The simulated clock

The portal has its own clock (seeded at Oct 16, 2026, 2:00 PM ET, shown in the footer). Transfers move from
Scheduled to Processing to Completed as the clock passes their times. Advance it from `/test-lab`.

A page keeps showing what it showed when it loaded, as a real page would. Actions are always evaluated against the
**current** persisted state, not what the page displayed. So if you open a transfer in one tab, advance the clock in
another, and then press Confirm in the first tab, the portal refuses with a "processing started" message (policy P7).

## Rules enforced by the portal

Enforcement lives in [`src/domain/rules.ts`](src/domain/rules.ts) as pure functions, independent of any agent. The UI
only calls them.

| Policy | Where it is written on the site | Where it is enforced |
| --- | --- | --- |
| P1 scheduled standard transfers can be canceled before processing | `/help/transfers` | `cancelTransfer` |
| P2 instant transfers cannot be canceled once submitted | `/help/instant-transfers`, `/help/faq` | `cancelTransfer` (`INSTANT_NOT_CANCELABLE`) |
| P3 completed transfers cannot be directly canceled | `/help/transfers` | `cancelTransfer` (`COMPLETED_NOT_CANCELABLE`) |
| P4 completed transfers may be eligible for recovery; not guaranteed | `/help/recovery` | `submitPaymentRecovery` |
| P5 recovery needs the reference number and recipient information | `/help/recovery` | `submitPaymentRecovery` |
| P6 unauthorized transfers use a separate procedure | `/help/unauthorized-transfers`, `/help/recovery` | The two report forms reject the wrong initiator answer |
| P7 cancellation requires a valid state at the moment of the action | `/help/transfers` | `cancelTransfer` runs on freshly read state |
| P8 general guidance does not override the instant exception | `/help/transfers`, `/help/instant-transfers` | Instant check precedes the general permission |

## Observable behavior for collectors

- Policies are ordinary prose in visible DOM text. Nothing is hidden behind collapsed sections or tabs.
- Controls use accessible names and stable `data-testid` values: `cancel-transfer`, `confirm-cancel`, `keep-transfer`,
  `transfer-status`, `payment-method`, `reference-number`, `express-recovery-link`, `case-id`.
- A disabled Cancel button is rendered (not removed) when cancellation is unavailable.
- The `b6` scenario has one off-origin link (`https://express-recovery.example/...`). It is a reserved example domain
  and never resolves.
- Support forms are `<form>` elements with accessible names and labeled fields. Submitting them changes only
  simulated state.

## Safety and scope

- No network calls, no AI integrations, no authentication, no database, no real or realistic banking identifiers.
- The reference number, names and addresses are fictional. Email addresses use reserved example domains.
- Do not commit `.env` files, build output, or test artifacts. See `.gitignore`.

## Layout

```text
mock-portal/
  src/domain/       types, scenarios, pure rules, localStorage store (no React in rules)
  src/pages/        routes
  src/components/   layout and form controls
  tests/unit/       rules and scenarios (offline, deterministic)
  tests/e2e/        Playwright against the built portal
  docs/             expected outcomes for test authors (not part of the site)
```
