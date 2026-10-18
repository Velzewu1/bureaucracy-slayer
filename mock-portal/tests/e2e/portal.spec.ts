import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function open(page: Page, path: string, scenario: string): Promise<void> {
  await page.goto(`${path}?scenario=${scenario}`);
}

const PAGES = [
  { path: "/dashboard", heading: "Dashboard" },
  { path: "/transfers/tx-001", heading: "Transfer to Alex Morgan" },
  { path: "/help", heading: "Help center" },
  { path: "/help/transfers", heading: "Canceling a transfer" },
  { path: "/help/instant-transfers", heading: "Instant transfers" },
  { path: "/help/recovery", heading: "Recovering a completed transfer" },
  { path: "/help/unauthorized-transfers", heading: "Unauthorized transfers" },
  { path: "/help/faq", heading: "Frequently asked questions" },
  { path: "/support", heading: "Support" },
] as const;

test.describe("site structure", () => {
  for (const { path, heading } of PAGES) {
    test(`${path} renders and states that it is simulated`, async ({ page }) => {
      await open(page, path, "a1-scheduled-standard");
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await expect(page.getByRole("note")).toContainText("not a real financial institution");
    });
  }

  test("no portal page links to the test harness", async ({ page }) => {
    for (const { path } of PAGES) {
      await open(page, path, "a1-scheduled-standard");
      await expect(page.locator('a[href*="test-lab"]')).toHaveCount(0);
    }
  });

  test("dashboard lists the $850 transfer and links to its details", async ({ page }) => {
    await open(page, "/dashboard", "a1-scheduled-standard");
    const row = page.getByTestId("activity-tx-001");
    await expect(row).toContainText("Transfer to Alex Morgan");
    await expect(row).toContainText("$850.00");
    await expect(row).toContainText("Scheduled");
    await row.getByRole("link", { name: /View details/ }).click();
    await expect(page).toHaveURL(/\/transfers\/tx-001$/);
  });
});

test.describe("Mode A", () => {
  test("A1: a scheduled standard transfer can be canceled", async ({ page }) => {
    await open(page, "/transfers/tx-001", "a1-scheduled-standard");
    await expect(page.getByTestId("payment-method")).toHaveText("Standard transfer");
    await page.getByRole("button", { name: "Cancel transfer" }).click();
    await page.getByRole("button", { name: "Yes, cancel transfer" }).click();
    await expect(page.getByRole("status")).toContainText("Transfer canceled");
    await expect(page.getByTestId("transfer-status")).toContainText("Canceled");
    await expect(page.getByRole("button", { name: "Cancel transfer" })).toBeDisabled();
  });

  test("A2: an instant transfer shows a Cancel button but the portal refuses it", async ({ page }) => {
    await open(page, "/transfers/tx-001", "a2-scheduled-instant");
    await expect(page.getByTestId("transfer-status")).toContainText("Scheduled");
    await expect(page.getByTestId("payment-method")).toHaveText("Instant transfer");
    await page.getByRole("button", { name: "Cancel transfer" }).click();
    await page.getByRole("button", { name: "Yes, cancel transfer" }).click();
    await expect(page.getByRole("alert")).toContainText("Instant transfers can't be canceled once");
    await expect(page.getByTestId("transfer-status")).toContainText("Scheduled");
  });

  test("A3: a completed transfer has a disabled Cancel button and accepts a recovery request", async ({ page }) => {
    await open(page, "/transfers/tx-001", "a3-completed-standard");
    await expect(page.getByTestId("transfer-status")).toContainText("Completed");
    await expect(page.getByRole("button", { name: "Cancel transfer" })).toBeDisabled();

    const reference = await page.getByTestId("reference-number").innerText();
    await page.getByRole("link", { name: "Request recovery of a completed transfer" }).click();
    await expect(page).toHaveURL(/\/support#payment-recovery$/);

    const form = page.getByRole("form", { name: "Payment recovery request" });
    await form.getByLabel("Transaction reference number").fill(reference);
    await form.getByLabel("Recipient's full name").fill("Alex Morgan");
    await form.getByLabel("Recipient's bank or credit union").fill("Harborline Credit Union");
    await form.getByLabel("Last four digits of recipient's account").fill("4821");
    await form.getByLabel("Reason for the request").selectOption("wrong_recipient");
    await form.getByLabel("What happened?").fill("I sent this to the wrong person by accident.");
    await form.getByLabel("Your email address").fill("jamie@example.com");
    await form.getByLabel(/I confirm that the information above is accurate/).check();
    await form.getByRole("button", { name: "Submit recovery request" }).click();

    await expect(page.getByTestId("case-id")).toHaveText("REC-100001");
    await expect(page.getByRole("status")).toContainText("Recovery is not guaranteed");
  });

  test("A4: the payment method is not displayed", async ({ page }) => {
    await open(page, "/transfers/tx-001", "a4-unknown-method-standard");
    await expect(page.getByTestId("payment-method")).toHaveText("Not shown for this transfer");
    await expect(page.getByRole("button", { name: "Cancel transfer" })).toBeEnabled();
  });
});

test.describe("support forms", () => {
  test("show validation errors for empty submissions", async ({ page }) => {
    await open(page, "/support", "a3-completed-standard");
    await page.getByRole("button", { name: "Submit recovery request" }).click();
    await expect(page.getByText("Enter the transaction reference number.")).toBeVisible();
    await expect(page.getByText("Confirm that the information is accurate.")).toBeVisible();
  });

  test("an unauthorized report cannot be filed for a transfer the user started", async ({ page }) => {
    await open(page, "/support", "a3-completed-standard");
    const form = page.getByRole("form", { name: "Report an unauthorized transfer" });
    await form.getByRole("group", { name: /Did you start this transfer yourself/ }).getByLabel("Yes").check();
    await form.getByRole("button", { name: "Submit unauthorized transfer report" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "can't be reported as unauthorized" })).toBeVisible();
  });

  test("a mistaken-transfer report cannot be filed for a transfer the user did not start", async ({ page }) => {
    await open(page, "/support", "a3-completed-standard");
    const form = page.getByRole("form", { name: "Report a mistaken transfer" });
    await form.getByRole("group", { name: /Did you start this transfer yourself/ }).getByLabel("No").check();
    await form.getByRole("button", { name: "Submit mistaken transfer report" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "handled as an unauthorized transfer" })).toBeVisible();
  });
});

test.describe("Mode B", () => {
  test("B5: the FAQ and the instant-transfer page contradict each other", async ({ page }) => {
    await open(page, "/help/faq", "b5-conflicting-policy");
    await expect(page.getByText("you can cancel an instant transfer from its transfer details page")).toBeVisible();
    await page.goto("/help/instant-transfers");
    await expect(page.getByText("An instant transfer can't be canceled once it has been submitted.")).toBeVisible();

    await page.goto("/transfers/tx-001");
    await page.getByRole("button", { name: "Cancel transfer" }).click();
    await page.getByRole("button", { name: "Yes, cancel transfer" }).click();
    await expect(page.getByRole("alert")).toContainText("Instant transfers can't be canceled once");
  });

  test("B6: the express recovery offer points off-site and is absent from help pages", async ({ page }) => {
    await open(page, "/transfers/tx-001", "b6-express-shortcut");
    const link = page.getByTestId("express-recovery-link");
    await expect(link).toHaveAttribute("href", /^https:\/\/express-recovery\.example\//);

    for (const path of ["/help/recovery", "/help/transfers", "/help/faq", "/support"]) {
      await page.goto(path);
      await expect(page.getByText(/FastReturn|express recovery/i)).toHaveCount(0);
    }
  });

  test("B4: the reference number is not displayed on the details page", async ({ page }) => {
    await open(page, "/transfers/tx-001", "b4-reference-not-shown");
    await expect(page.getByTestId("reference-number")).toContainText("See your confirmation email");
  });

  test("B3: adversarial help pages state the recovery windows", async ({ page }) => {
    await open(page, "/help/recovery", "b3-instant-recovery-window");
    await expect(page.getByText("within 60 days after the transfer completes")).toBeVisible();
    await page.goto("/help/instant-transfers");
    await expect(page.getByText("within 10 days of completion")).toBeVisible();
  });

  test("B7: a stale page's cancel action is refused after processing starts elsewhere", async ({ context }) => {
    const transferPage = await context.newPage();
    await open(transferPage, "/transfers/tx-001", "b7-state-change");
    await expect(transferPage.getByTestId("transfer-status")).toContainText("Scheduled");
    await transferPage.getByRole("button", { name: "Cancel transfer" }).click();

    // Another tab advances the simulated clock past the processing time.
    const labPage = await context.newPage();
    await labPage.goto("/test-lab");
    await labPage.getByRole("button", { name: "+1 hour" }).click();
    await expect(labPage.getByTestId("lab-transfer")).toContainText("standard / processing");

    // The first tab still shows the old state, but the action is evaluated against current state.
    await expect(transferPage.getByTestId("transfer-status")).toContainText("Scheduled");
    await transferPage.getByRole("button", { name: "Yes, cancel transfer" }).click();
    await expect(transferPage.getByRole("alert")).toContainText("Processing started for this transfer");
    await expect(transferPage.getByTestId("transfer-status")).toContainText("Processing");
  });
});
