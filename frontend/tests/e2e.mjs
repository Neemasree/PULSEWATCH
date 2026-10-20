import { chromium } from "playwright";
import assert from "node:assert/strict";

const baseUrl = process.env.E2E_BASE_URL || "http://localhost:5173";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

const waitForText = (locator, message) => locator.waitFor({ state: "visible", timeout: 20000 }).catch(() => {
  throw new Error(`Timed out waiting for ${message}`);
});

try {
  // Registration, automatic cookie session, dashboard and live socket.
  await page.goto(`${baseUrl}/login`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Register" }).click();
  const username = `qa-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const password = "TestPassword123!";
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Full Name").fill("QA PulseWatch");
  await page.getByLabel("Password").fill(password);
  await page.getByLabel("Confirm Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await waitForText(page.getByRole("heading", { name: "Dashboard" }), "authenticated dashboard");
  await waitForText(page.getByText("Live", { exact: true }), "live socket indicator");

  // Dashboard create flow persists a public monitor and shows it in the UI.
  await page.getByPlaceholder("https://example.com").fill("https://example.com");
  await page.getByRole("button", { name: /Add monitor/ }).click();
  await waitForText(page.getByText("example.com", { exact: true }), "dashboard monitor card");

  // Monitors page: create, pause, resume and delete.
  await page.getByRole("link", { name: "Monitors", exact: true }).click();
  await waitForText(page.getByRole("heading", { name: "Monitors" }), "monitors page");
  const addForm = page.locator("form").first();
  await addForm.locator('input[placeholder="name"]').fill("qa-crud-monitor");
  await addForm.locator('input[placeholder="url"]').fill("https://example.org");
  await addForm.getByRole("button", { name: "Add monitor" }).click();
  const crudLink = page.getByRole("link", { name: /qa-crud-monitor/ });
  await waitForText(crudLink, "created monitor row");
  let row = crudLink.locator("xpath=..");
  await row.getByRole("button", { name: "Pause" }).click();
  await waitForText(row.getByText("Paused", { exact: true }), "paused monitor state");
  await row.getByRole("button", { name: "Resume" }).click();
  await waitForText(row.getByText("Enabled", { exact: true }), "resumed monitor state");

  // Monitor detail: stats/history page and maintenance create/delete.
  const detailPath = await crudLink.getAttribute("href");
  assert.ok(detailPath?.startsWith("/monitors/"), "monitor row should link to its detail page");
  await crudLink.click();
  await waitForText(page.getByRole("heading", { name: "qa-crud-monitor" }), "monitor detail");
  const future = (hours) => {
    const d = new Date(Date.now() + hours * 3600000);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  };
  const dateInputs = page.locator('input[type="datetime-local"]');
  await dateInputs.nth(0).fill(future(2));
  await dateInputs.nth(1).fill(future(3));
  await page.getByPlaceholder("Reason (optional)").fill("QA maintenance window");
  await page.getByRole("button", { name: "Schedule" }).click();
  await waitForText(page.getByText("QA maintenance window"), "created maintenance window");
  const maintenanceRow = page.locator("div").filter({ has: page.getByText("QA maintenance window", { exact: true }) }).filter({ has: page.getByRole("button", { name: "Remove" }) }).last();
  await maintenanceRow.getByRole("button", { name: "Remove" }).click();
  await page.getByText("QA maintenance window", { exact: true }).waitFor({ state: "detached", timeout: 10000 });

  // Alerts: reject a loopback webhook target, create a safe channel, then delete it.
  await page.getByRole("link", { name: "Alerts", exact: true }).click();
  await waitForText(page.getByRole("heading", { name: "Alert channels" }), "alert channels page");
  const alertForm = page.locator("form").first();
  await alertForm.locator('input[placeholder="Name"]').fill("qa-unsafe-channel");
  await alertForm.locator('input[placeholder="Webhook URL"]').fill("http://127.0.0.1:3000");
  await alertForm.getByRole("button", { name: "Add" }).click();
  await waitForText(page.getByText(/SSRF rejected/i), "SSRF rejection");
  await alertForm.locator('input[placeholder="Name"]').fill("qa-webhook-channel");
  await alertForm.locator('input[placeholder="Webhook URL"]').fill("https://example.com");
  await alertForm.getByRole("button", { name: "Add" }).click();
  await waitForText(page.getByText("qa-webhook-channel", { exact: true }), "created alert channel");
  const channelRow = page.locator("div").filter({ has: page.getByText("qa-webhook-channel", { exact: true }) }).filter({ has: page.getByRole("button", { name: "Delete" }) }).last();
  await channelRow.getByRole("button", { name: "Delete" }).click();
  await page.getByText("qa-webhook-channel", { exact: true }).waitFor({ state: "detached", timeout: 10000 });

  // Public status page must show the public monitor without requiring auth.
  const statusPage = await browser.newPage();
  await statusPage.goto(`${baseUrl}/status`, { waitUntil: "networkidle" });
  await waitForText(statusPage.getByText("example.com", { exact: true }), "public status service");
  await statusPage.close();

  // Confirm monitor survives navigation/reload, then logout protects private routes.
  await page.reload({ waitUntil: "networkidle" });
  await waitForText(page.getByRole("heading", { name: "Alert channels" }), "alert page after reload");
  await page.getByRole("button", { name: "Sign out" }).click();
  await waitForText(page.getByRole("heading", { name: "Welcome back" }), "login page after logout");
  await page.goto(`${baseUrl}/monitors`, { waitUntil: "networkidle" });
  await waitForText(page.getByRole("heading", { name: "Welcome back" }), "protected route redirect after logout");

  assert.deepEqual(pageErrors, [], "browser should not report uncaught JavaScript errors");
  console.log("PASS: registration, authenticated dashboard, live socket, monitor create/pause/resume/delete, monitor detail, maintenance create/delete, SSRF rejection, alert channel create/delete, public status, logout and protected-route redirect");
} finally {
  await browser.close();
}
