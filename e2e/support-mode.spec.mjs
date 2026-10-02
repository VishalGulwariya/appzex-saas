import { expect, test } from "@playwright/test";

const seedPassword = process.env.SEED_PASSWORD?.trim() || "password123";
const superAdminEmail = "superadmin@appzex.local";
const suspendedAdminEmail = "admin@suspended.local";

async function signInFromLogin(page, email, password) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
}

async function endSupportSessionIfOpen(page) {
  const exit = page.getByRole("button", { name: "Exit Support Mode", exact: true });
  if (await exit.count()) await exit.click();
}

test.describe.configure({ mode: "serial" });

test.afterEach(async ({ page }) => {
  await endSupportSessionIfOpen(page).catch(() => undefined);
});

test("Super Admin sees a support mode banner in the agency workspace and can exit it", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await signInFromLogin(page, superAdminEmail, seedPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/super-admin");
  await page.getByRole("button", { name: "agencies", exact: true }).click();
  await page.getByRole("button", { name: /Apex Digital Marketing/ }).first().click();
  await page.getByRole("button", { name: "Enter support mode", exact: true }).click();
  await page.getByLabel("Reason").fill("Evaluation walkthrough of tenant isolation and derived progress.");
  await page.getByRole("button", { name: "Start support session", exact: true }).click();

  await page.waitForURL("**/agency");
  const banner = page.getByTestId("support-mode-banner");
  await expect(banner).toBeVisible();
  await expect(banner.getByText("Viewing Apex Digital Marketing in Super Admin Support Mode", { exact: true })).toBeVisible();
  await expect(banner.getByRole("button", { name: "Exit Support Mode", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Apex Digital Marketing", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "Exit Support Mode", exact: true }).click();
  await page.waitForURL("**/super-admin");
  await expect(page.getByTestId("support-mode-banner")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

const loginAlert = (page) => page.locator("form").getByRole("alert");

test("a suspended agency user is locked out with a clear 403 message", async ({ page }) => {
  const responses = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/v1/auth/login")) responses.push({ status: response.status() });
  });

  await signInFromLogin(page, suspendedAdminEmail, seedPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  await expect(loginAlert(page)).toContainText("Stalled Creative");
  await expect(loginAlert(page)).toContainText("suspended");
  expect(responses.length).toBe(1);
  expect(responses[0]?.status).toBe(403);
  await expect(page).toHaveURL(/\/login/);
});

async function superAdminSession(request) {
  const csrfResponse = await request.get("/api/v1/auth/csrf");
  const csrfToken = (await csrfResponse.json()).csrfToken;
  const login = await request.post("/api/v1/auth/login", {
    headers: { "X-CSRF-Token": csrfToken, "Content-Type": "application/json" },
    data: { email: superAdminEmail, password: seedPassword }
  });
  if (!login.ok()) throw new Error(`Super Admin API sign-in failed with ${login.status()}`);
  return csrfToken;
}

test("suspending an agency revokes workspace access for sessions that already exist", async ({ page, request }) => {
  await signInFromLogin(page, "admin@agencyb.local", seedPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/agency");

  const before = await page.evaluate(async () => (await fetch("/api/v1/agency/projects", { credentials: "include" })).status);
  expect(before).toBe(200);

  const csrfToken = await superAdminSession(request);
  try {
    const suspend = await request.patch("/api/v1/admin/agencies/agc_eval_nexus/status", {
      headers: { "X-CSRF-Token": csrfToken, "Content-Type": "application/json" },
      data: { status: "SUSPENDED" }
    });
    expect(suspend.status()).toBe(200);

    const blocked = await page.evaluate(async () => {
      const response = await fetch("/api/v1/agency/projects", { credentials: "include" });
      return { status: response.status, body: await response.json() };
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ error: { code: "AGENCY_SUSPENDED" } });
  } finally {
    await request.patch("/api/v1/admin/agencies/agc_eval_nexus/status", {
      headers: { "X-CSRF-Token": csrfToken, "Content-Type": "application/json" },
      data: { status: "ACTIVE" }
    });
  }
});