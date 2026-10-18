import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { chromium, type Page } from "playwright";

/**
 * Real-browser verification (opt-in; not part of `npm test`).
 *
 *   npm run build:extension
 *   (start the Northstar Mock Bank on http://127.0.0.1:5180 yourself)
 *   npm run verify:extension
 *
 * Set VERIFY_CHANNEL=chrome to try branded Chrome. Recent branded Chrome
 * builds ignore --load-extension; Edge or Chrome for Testing still load
 * unpacked extensions. No Anthropic or other external network is used.
 */

const PORTAL = "http://127.0.0.1:5180";
const extensionDir = resolve("extension/dist");
const shots = resolve("extension/verification/screenshots");
const profile = resolve("extension/.tmp/profile-verify");
mkdirSync(shots, { recursive: true });
rmSync(profile, { recursive: true, force: true });

const results: { check: string; pass: boolean; detail?: string }[] = [];
function record(check: string, pass: boolean, detail?: string): void {
  results.push({ check, pass, ...(detail === undefined ? {} : { detail }) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${check}${detail === undefined ? "" : `  (${detail})`}`);
}

const context = await chromium.launchPersistentContext(profile, {
  channel: process.env["VERIFY_CHANNEL"] ?? "msedge",
  headless: false,
  viewport: { width: 1100, height: 800 },
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).host;

  const portal = context.pages()[0] ?? (await context.newPage());
  const portalRequests: string[] = [];
  portal.on("request", (request) => {
    if (request.method() !== "GET") portalRequests.push(`${request.method()} ${request.url()}`);
  });
  const dialogs: string[] = [];
  portal.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await portal.goto(`${PORTAL}/dashboard`);

  const panel = await context.newPage();
  await panel.setViewportSize({ width: 420, height: 980 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByRole("button", { name: "Reset demo" }).click();
  await panel.getByText("No guidance loaded").waitFor();

  const shot = async (page: Page, name: string) => page.screenshot({ path: resolve(shots, `${name}.png`) });
  const highlighted = () => portal.locator("[data-slayer-highlight]").count();
  const load = async (fixtureId: string, expectText: string) => {
    await panel.getByLabel("Fixture scenario").selectOption(fixtureId);
    await panel.getByRole("button", { name: "Load scenario" }).click();
    await panel.getByText(expectText).first().waitFor();
  };
  const bodyText = () => panel.locator("#slayer-panel").innerText();

  // 0. Empty state
  record("No guidance: nothing navigable offered", (await panel.getByRole("button", { name: /Open page|Show on page/ }).count()) === 0);
  await shot(panel, "01-no-guidance");

  // 1. Verified fixture-backed cancellation route
  await load("cancel-ready", "Verified route");
  record("Fixture banner distinguishes demo from live sync", (await bodyText()).includes("not live-synchronized"));
  record("Ready route shows two ordered steps", (await panel.locator("li.step").count()) === 2);
  record("Panel hides internal ids", !/rule_|proc_|action_|plan_|block_|transfer_status/.test(await bodyText()));
  await shot(panel, "02-verified-route");

  // 2. Highlight the observed dashboard link (step 1) without clicking
  await panel.locator("li.step").nth(0).getByRole("button", { name: "Show on page" }).click();
  await panel.getByText(/Highlighted on the page/).waitFor();
  record("Observed navigation link highlighted on dashboard", (await highlighted()) === 1);
  const highlightedHref = await portal.locator("[data-slayer-highlight]").first().evaluate((node) =>
    node instanceof HTMLAnchorElement ? node.href : "",
  );
  const highlightedName = await portal.locator("[data-slayer-highlight]").first().evaluate((node) =>
    node.getAttribute("aria-label") ?? node.textContent ?? "",
  );
  record(
    "Highlighted element is the expected link",
    highlightedHref === `${PORTAL}/transfers/tx-001` && /View details for Transfer to Alex Morgan/.test(highlightedName),
    `${highlightedName} -> ${highlightedHref}`,
  );
  record("Highlight did not navigate the page", portal.url() === `${PORTAL}/dashboard`);
  await shot(portal, "03-dashboard-link-highlighted");

  // 3. Click the permitted navigation step
  await panel.locator("li.step").nth(0).getByRole("button", { name: "Open page" }).click();
  await portal.waitForURL(`${PORTAL}/transfers/tx-001`);
  record("Open page navigated to the observed transfer page", portal.url() === `${PORTAL}/transfers/tx-001`);
  record("Stale highlight removed after navigation", (await highlighted()) === 0);
  await shot(portal, "04-transfer-page-opened");

  // 4. State-changing control: highlight only
  const cancelRow = panel.locator("li.step").nth(1);
  record("Cancel step has no Open page button", (await cancelRow.getByRole("button", { name: "Open page" }).count()) === 0);
  record("Cancel step is labeled as the user's own action", (await cancelRow.innerText()).includes("never click"));
  await cancelRow.getByRole("button", { name: "Show on page" }).click();
  await panel.getByText(/Highlighted on the page/).waitFor();
  record("Cancel button highlighted", (await highlighted()) === 1);
  record(
    "Highlight is on the Cancel transfer button",
    (await portal.locator("[data-slayer-highlight]").first().innerText()).includes("Cancel transfer"),
  );
  await portal.waitForTimeout(2500);
  record("Cancel never auto-clicked (still on page, no dialog)", portal.url() === `${PORTAL}/transfers/tx-001` && dialogs.length === 0);
  record("No non-GET request was sent by the page", portalRequests.length === 0, portalRequests.join(" | "));
  record("Page still shows no cancellation result", !/transfer (has been )?canceled/i.test(await portal.locator("body").innerText()));
  await shot(portal, "05-cancel-highlighted-not-clicked");

  // 5. Reload clears the highlight
  await portal.reload();
  await portal.waitForLoadState("load");
  record("Reloaded page has no stale highlight", (await highlighted()) === 0);

  // 6. Facts changed in the same session -> prohibition replaces the route
  await load("cancel-facts-changed", "No permitted route");
  record("Changed facts: route replaced by a prohibition", (await panel.locator("li.step").count()) === 0);
  record("Changed facts: no navigation controls", (await panel.getByRole("button", { name: /Open page|Show on page/ }).count()) === 0);
  await shot(panel, "06-facts-changed-blocked");

  // 7. The older route cannot come back
  await panel.getByLabel("Fixture scenario").selectOption("cancel-ready");
  await panel.getByRole("button", { name: "Load scenario" }).click();
  await panel.getByText(/Rejected: this is an older analysis/).waitFor();
  record("Older route replayed after change is rejected", (await panel.getByText("No permitted route").count()) >= 1);

  // 8. Review-required recorded analysis
  await load("review-required-recorded", "Review required");
  record("Review required: no authorized route", (await panel.locator("li.step").count()) === 0);
  record("Review required: no navigation controls", (await panel.getByRole("button", { name: /Open page|Show on page|Mark done/ }).count()) === 0);
  record("Review required never reads as ready", !/Verified route/.test(await bodyText()));
  await shot(panel, "07-review-required");

  // 9. Other non-ready states
  await load("needs-information", "More information needed");
  record("Needs information lists the missing detail", (await bodyText()).includes("Payment method"));
  await load("missing-evidence", "Review required");
  record("Rejected evidence yields review, not a route", (await panel.locator("li.step").count()) === 0);
  await shot(panel, "08-evidence-rejected");

  // 10. Session invalidation
  await panel.getByRole("button", { name: "Reset demo" }).click();
  await load("cancel-ready", "Verified route");
  await portal.goto(`${PORTAL}/dashboard`);
  await panel.locator("li.step").nth(0).getByRole("button", { name: "Show on page" }).click();
  await panel.getByText(/Highlighted on the page/).waitFor();
  record("Fresh session highlights again", (await highlighted()) === 1);
  await panel.getByRole("button", { name: "Invalidate session" }).click();
  await panel.getByText("Session invalidated").waitFor();
  record("Invalidated session shows no route", (await panel.locator("li.step").count()) === 0);
  record("Invalidation removed the page highlight", (await highlighted()) === 0);
  const urlBefore = portal.url();
  const denied = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: "OPEN_STEP", index: 1 }))) as { outcome: string };
  record("Open request against an invalidated session is denied", denied.outcome === "denied" && portal.url() === urlBefore, denied.outcome);
  const deniedShow = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: "SHOW_STEP", index: 2 }))) as { outcome: string };
  record("Show request against an invalidated session is denied", deniedShow.outcome === "denied", deniedShow.outcome);
  await shot(panel, "09-session-invalidated");

  // 11. Content script ignores page-originated messages
  const pageReply = await portal.evaluate(
    () =>
      new Promise<string>((resolveReply) => {
        window.postMessage({ type: "HIGHLIGHT" }, "*");
        setTimeout(() => resolveReply("no-effect"), 300);
      }),
  );
  record("Page postMessage cannot trigger the content script", pageReply === "no-effect" && (await highlighted()) === 0);

  const failed = results.filter((result) => !result.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  await context.close();
}
