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
const profile = resolve("extension/.tmp/profile-verify-ui");
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
  await panel.setViewportSize({ width: 360, height: 980 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await panel.getByText("Developer / Demo controls").waitFor();

  const openDemo = async () => {
    const demo = panel.locator("details.demo-controls");
    if (!(await demo.evaluate((node) => node instanceof HTMLDetailsElement && node.open))) {
      await demo.locator("summary").click();
    }
  };
  const noHorizontalOverflow = async () =>
    panel.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

  record(
    "Demo controls collapsed by default",
    !(await panel.locator("details.demo-controls").evaluate((node) => node instanceof HTMLDetailsElement && node.open)),
  );
  await openDemo();
  await panel.getByRole("button", { name: "Reset demo" }).click();
  await panel.getByText("No guidance loaded").waitFor();
  await panel.locator("details.demo-controls summary").click();

  const shot = async (page: Page, name: string) => page.screenshot({ path: resolve(shots, `${name}.png`) });
  const highlighted = () => portal.locator("[data-slayer-highlight]").count();
  const load = async (fixtureId: string, expectText: string) => {
    await openDemo();
    await panel.getByLabel("Fixture scenario").selectOption(fixtureId);
    await panel.getByRole("button", { name: "Load scenario" }).click();
    await panel.getByText(expectText).first().waitFor();
  };
  const bodyText = () => panel.locator("#slayer-panel").innerText();

  // 0. Empty state
  record("No guidance: nothing navigable offered", (await panel.getByRole("button", { name: /Open page|Show on page/ }).count()) === 0);
  record("Goal box is on the primary screen", (await panel.getByLabel("Your goal").count()) === 1);
  await shot(panel, "01-no-guidance");

  const analyze = async (goal: string) => {
    await panel.getByLabel("Your goal").fill(goal);
    await panel.getByRole("button", { name: "Analyze Website" }).click();
  };
  const choose = async (label: string, option: string) => {
    await panel.getByRole("group", { name: label }).getByRole("button", { name: option, exact: true }).click();
  };

  // Goal-driven offline fixtures
  const cancelGoal = "Can I cancel my scheduled bank transfer?";
  await analyze(cancelGoal);
  await panel.getByText("Needs information").first().waitFor();
  record("A1 with no facts asks for information", (await bodyText()).includes("Still needed"));
  record("A1 provenance is the offline fixture label", (await bodyText()).includes("Offline fixture — not a live analysis."));
  await shot(panel, "10-goal-questions");
  await panel.getByRole("button", { name: "All facts" }).click();
  await choose("Transfer status", "Scheduled");
  await choose("Transfer type", "Standard");
  await choose("Transfer processing has begun", "No");
  await panel.getByText("Verified route").waitFor();
  record("A1 ready route is the cancel step only", (await panel.locator("li.step").count()) === 1);
  record("A1 ready step does not offer Open page", (await panel.getByRole("button", { name: "Open page" }).count()) === 0);
  for (const width of [320, 360, 400] as const) {
    await panel.setViewportSize({ width, height: 980 });
    record(`Goal route at ${width}px has no horizontal overflow`, await noHorizontalOverflow());
    await shot(panel, `11-goal-ready-${width}w`);
  }
  await panel.setViewportSize({ width: 360, height: 980 });
  await panel.getByRole("button", { name: "Show on page" }).click();
  await panel.getByText(/Highlighted on the page|Complete the action yourself/).waitFor();
  record("A1 show-on-page highlights Cancel and does not click it", (await highlighted()) === 1 && dialogs.length === 0);
  record(
    "A1 highlight is the Cancel transfer button",
    (await portal.locator("[data-slayer-highlight]").first().innerText()).includes("Cancel transfer"),
  );
  await portal.waitForTimeout(1500);
  record("A1 show-on-page sent no non-GET request", portalRequests.length === 0, portalRequests.join(" | "));
  await shot(portal, "12-goal-cancel-highlighted");

  await choose("Transfer type", "Instant");
  await panel.getByText("No permitted route").waitFor();
  record("A1 instant transfer removes the route", (await panel.locator("li.step").count()) === 0);
  await shot(panel, "13-goal-prohibited");

  await panel.getByLabel("Your goal").fill(`${cancelGoal} today`);
  await panel.getByText("Session invalidated").waitFor();
  record("Editing the goal invalidates the previous route", (await panel.locator("li.step").count()) === 0);
  const deniedGoal = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: "SHOW_STEP", index: 1 }))) as { outcome: string };
  record("Show against a goal-invalidated session is denied", deniedGoal.outcome === "denied", deniedGoal.outcome);
  await shot(panel, "14-goal-invalidated");

  await analyze("Please move this money somewhere else");
  await panel.getByText("This goal is not available in the offline demonstration.").waitFor();
  record("Unsupported goal does not load a route", (await panel.locator("li.step").count()) === 0 && !(await bodyText()).includes("Verified route"));
  await shot(panel, "15-unsupported-goal");

  await analyze("I sent a completed transfer to the wrong recipient. How can I recover it?");
  await panel.getByRole("button", { name: "All facts" }).click();
  await choose("Transfer status", "Completed");
  await choose("User started the transfer themselves", "Yes");
  await choose("Transfer type", "Scheduled");
  await panel.getByText("Human review required").waitFor();
  record("A2 completed recovery stays in review", (await panel.locator("li.step").count()) === 0);
  await shot(panel, "16-goal-review");

  await analyze("I found a transfer I did not authorize. What should I do?");
  await panel.getByRole("button", { name: "All facts" }).click();
  await choose("User started the transfer themselves", "No");
  await panel.getByText("Needs information").first().waitFor();
  await shot(panel, "17-unauthorized-questions");
  await choose("Transfer reference number is available", "Yes");
  await choose("Date first noticed is available", "Yes");
  await choose("Account has been secured", "No");
  await panel.getByText("Verified route").waitFor();
  record("A3 completed facts produce a ready route", (await panel.locator("li.step").count()) >= 1);
  record("A3 ready route is not an Open page action", (await panel.getByRole("button", { name: "Open page" }).count()) === 0);
  await shot(panel, "18-unauthorized-ready");

  await openDemo();
  await panel.getByRole("button", { name: "Reset demo" }).click();
  await panel.getByText("No guidance loaded").waitFor();
  await panel.getByLabel("Your goal").fill("");
  await portal.goto(`${PORTAL}/dashboard`);

  // 1. Verified fixture-backed cancellation route
  await load("cancel-ready", "Verified route");
  record("Developer fixture stays labeled as a fixture", (await bodyText()).includes("Offline fixture") && (await bodyText()).includes("Fixture demonstration"));
  record("Developer note stays out of the collapsed main view", (await panel.locator("details.demo-controls").evaluate((node) => node instanceof HTMLDetailsElement && !node.open)));
  record("Ready route shows two ordered steps", (await panel.locator("li.step").count()) === 2);
  record("Active step is labeled as step 1 of 2", /step 1 of 2/i.test(await bodyText()));
  await panel.locator("li.step").nth(0).getByRole("button", { name: "Mark done" }).click();
  await panel.getByText(/step 2 of 2/i).waitFor();
  record("Mark done advances the active step", /step 2 of 2/i.test(await bodyText()));
  await panel.locator("li.step").nth(0).getByRole("button", { name: "Undo done" }).click();
  await panel.getByText(/step 1 of 2/i).waitFor();
  record("Undo done restores step 1 as active", /step 1 of 2/i.test(await bodyText()));
  await panel.locator("li.step.next details.sources summary").click();
  record("Source citation expands", (await panel.locator("li.step.next blockquote").count()) === 1);
  const tabbed = await panel.evaluate(() => {
    const first = document.querySelector("button, select, summary, a");
    if (!(first instanceof HTMLElement)) return false;
    first.focus();
    return document.activeElement === first;
  });
  record("Keyboard can focus a control", tabbed);
  record("Panel hides internal ids", !/rule_|proc_|action_|plan_|block_|transfer_status/.test(await bodyText()));
  await shot(panel, "02-verified-route");
  for (const width of [320, 360, 400] as const) {
    await panel.setViewportSize({ width, height: 980 });
    record(`${width}px panel has no horizontal overflow`, await noHorizontalOverflow());
    await shot(panel, `02-verified-${width}w`);
  }
  await panel.setViewportSize({ width: 360, height: 980 });

  // 2. Highlight the observed dashboard link (step 1) without clicking
  await panel.locator("li.step").nth(0).getByRole("button", { name: "Show on page" }).click();
  await panel.getByText(/Highlighted on the page|Complete the action yourself/).waitFor();
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
  await cancelRow.getByRole("button", { name: "Cancel the transfer" }).click();
  record("Cancel step has no Open page button", (await cancelRow.getByRole("button", { name: "Open page" }).count()) === 0);
  record("Cancel step is labeled as the user's own action", (await cancelRow.innerText()).includes("never click"));
  await cancelRow.getByRole("button", { name: "Show on page" }).click();
  await panel.getByText(/Highlighted on the page|Complete the action yourself/).waitFor();
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
  await openDemo();
  await panel.getByLabel("Fixture scenario").selectOption("cancel-ready");
  await panel.getByRole("button", { name: "Load scenario" }).click();
  await panel.getByText(/Rejected: this is an older analysis/).waitFor();
  record("Older route replayed after change is rejected", (await panel.getByText("No permitted route").count()) >= 1);

  // 8. Review-required recorded analysis
  await load("review-required-recorded", "Human review required");
  record("Review required: no authorized route", (await panel.locator("li.step").count()) === 0);
  record("Review required: no navigation controls", (await panel.getByRole("button", { name: /Open page|Show on page|Mark done/ }).count()) === 0);
  record("Review required never reads as ready", !/Verified route/.test(await bodyText()));
  await shot(panel, "07-review-required");

  // 9. Other non-ready states
  await load("needs-information", "Needs information");
  record("Needs information lists the missing detail", (await bodyText()).includes("Payment method"));
  await shot(panel, "08-needs-information");
  await load("missing-evidence", "Human review required");
  record("Rejected evidence yields review, not a route", (await panel.locator("li.step").count()) === 0);
  await shot(panel, "08-evidence-rejected");

  // 10. Session invalidation
  await openDemo();
  await panel.getByRole("button", { name: "Reset demo" }).click();
  await load("cancel-ready", "Verified route");
  await portal.goto(`${PORTAL}/dashboard`);
  await panel.locator("li.step").nth(0).getByRole("button", { name: "Show on page" }).click();
  await panel.getByText(/Highlighted on the page|Complete the action yourself/).waitFor();
  record("Fresh session highlights again", (await highlighted()) === 1);
  await openDemo();
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
