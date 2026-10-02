import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { control, openProject, readFixtures, signIn } from "./test-helpers.mjs";

const requireFromApi = createRequire(resolve(process.cwd(), "apps/api/package.json"));
const { PrismaClient } = requireFromApi("@prisma/client");

async function browserPostHealthReport(page, projectId, includeCsrf = true) {
  return page.evaluate(async ({ id, withCsrf }) => {
    let csrfToken = "";
    if (withCsrf) {
      const csrfResponse = await fetch("/api/v1/auth/csrf", { credentials: "include" });
      csrfToken = (await csrfResponse.json()).csrfToken;
    }
    const response = await fetch(`/api/v1/agency/projects/${id}/health-report`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(withCsrf ? { "X-CSRF-Token": csrfToken } : {}) },
      body: "{}"
    });
    return { status: response.status, body: await response.json() };
  }, { id: projectId, withCsrf: includeCsrf });
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => {
  await control(request, "reset", "valid");
});

test("A: an upstream quota rejection keeps backend metrics authoritative without retry spam or a stuck spinner", async ({ page, request }) => {
  // Runs first so the tenant AI-report budget is untouched; the limit is five per window.
  const fixture = readFixtures();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await control(request, "reset", "quota");
  await signIn(page, fixture.ownerEmail, fixture.password);
  await openProject(page, fixture.assignedProjectName);

  await page.getByRole("button", { name: "Generate report", exact: true }).click();
  const drawer = page.locator("aside");
  await expect(drawer.getByText("The AI provider could not produce a valid report. Try again.", { exact: true })).toBeVisible();
  await expect(drawer.getByText("AI narrative summary temporarily unavailable due to provider capacity; backend metrics are authoritative.", { exact: true })).toBeVisible();

  // Authoritative backend metrics stay visible alongside the advisory banner.
  await expect(drawer.getByText("Backend-calculated metrics", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Task completion", { exact: true })).toBeVisible();
  await expect(drawer.getByText("50%", { exact: true })).toHaveCount(2);
  await expect(drawer.getByText("1/2", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Overdue tasks", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Open feedback", { exact: true })).toBeVisible();

  // No narrative is rendered, no upstream detail leaks, and the drawer is usable again.
  await expect(drawer.getByText("NEEDS ATTENTION", { exact: true })).toHaveCount(0);
  await expect(page.getByText("synthetic upstream quota or billing detail")).toHaveCount(0);
  await expect(page.getByText("quota_or_billing")).toHaveCount(0);
  await expect(page.getByText("Bearer ")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Generate report", exact: true })).toBeEnabled();
  await expect(page.getByRole("heading", { name: fixture.assignedProjectName, level: 2 })).toBeVisible();

  // Exactly one upstream request: no polling, no automatic retry.
  expect((await control(request, "state")).requestCount).toBe(1);
  expect(pageErrors).toEqual([]);

  await control(request, "reset", "valid");
  await page.getByRole("button", { name: "Generate report", exact: true }).click();
  await expect(drawer.getByText("Synthetic advisory for browser verification.")).toBeVisible();
  expect((await control(request, "state")).requestCount).toBe(1);
});

test("B: authorized owner opens a synthetic project and renders the report", async ({ page, request }) => {
  const fixture = readFixtures();
  await signIn(page, fixture.ownerEmail, fixture.password);
  await openProject(page, fixture.assignedProjectName);

  await page.getByRole("button", { name: "Generate report", exact: true }).click();
  const drawer = page.locator("aside");
  await expect(drawer.getByText("Synthetic advisory for browser verification.")).toBeVisible();
  await expect(drawer.getByText("NEEDS ATTENTION", { exact: true })).toBeVisible();
  await expect(drawer.getByText("Task completion")).toBeVisible();
  await expect(drawer.getByText("50%", { exact: true })).toHaveCount(2);
  await expect(drawer.getByText("Review the synthetic task.")).toBeVisible();
  await expect(drawer.getByText(fixture.otherTenantProjectName)).toHaveCount(0);

  const state = await control(request, "state");
  expect(state.requestCount).toBe(1);
  expect(state.lastMetadata).toMatchObject({
    method: "POST", path: "/v1/responses", authorizationPresent: true,
    modelPresent: true, strictSchema: true, schemaNamePresent: true, storeFalse: true,
    projectSentinelPresent: true, taskSentinelPresent: true,
    privateFileSentinelAbsent: true, privateMeetingSentinelAbsent: true
  });
});

test("B: a held provider response keeps the action loading and prevents duplicate requests", async ({ page, request }) => {
  const fixture = readFixtures();
  await control(request, "reset", "hold");
  await signIn(page, fixture.ownerEmail, fixture.password);
  await openProject(page, fixture.assignedProjectName);
  await page.getByRole("button", { name: "Generate report", exact: true }).click();

  const generateButton = page.getByRole("button", { name: "Generating…", exact: true });
  await expect(generateButton).toBeDisabled();
  await expect.poll(async () => (await control(request, "state")).requestCount).toBe(1);
  await expect(generateButton).toHaveCount(1);
  expect((await control(request, "state")).requestCount).toBe(1);

  try {
    await control(request, "release");
    await expect(page.locator("aside").getByText("Synthetic advisory for browser verification.")).toBeVisible();
  } finally {
    await control(request, "release");
  }
});

test("C: a provider error is safe and the user can retry", async ({ page, request }) => {
  const fixture = readFixtures();
  await control(request, "reset", "error");
  await signIn(page, fixture.ownerEmail, fixture.password);
  await openProject(page, fixture.assignedProjectName);
  await page.getByRole("button", { name: "Generate report", exact: true }).click();

  await expect(page.getByText("The AI provider could not produce a valid report. Try again.", { exact: true })).toBeVisible();
  await expect(page.getByText("synthetic upstream provider detail")).toHaveCount(0);
  await expect(page.getByText("Bearer ")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Generate report", exact: true })).toBeEnabled();
  expect((await control(request, "state")).requestCount).toBe(1);

  await control(request, "reset", "valid");
  await page.getByRole("button", { name: "Generate report", exact: true }).click();
  await expect(page.locator("aside").getByText("Synthetic advisory for browser verification.")).toBeVisible();
  expect((await control(request, "state")).requestCount).toBe(1);
});

test("D: malformed API response is rejected without crashing the drawer", async ({ page, request }) => {
  const fixture = readFixtures();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await signIn(page, fixture.ownerEmail, fixture.password);
  await openProject(page, fixture.assignedProjectName);
  await page.route(`**/api/v1/agency/projects/${fixture.assignedProjectId}/health-report`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ advisory: true, generatedAt: "not-a-date", metrics: null, report: { risks: null } })
  }));

  await page.getByRole("button", { name: "Generate report", exact: true }).click();
  await expect(page.getByText("The health report response was invalid.", { exact: true })).toBeVisible();
  await expect(page.locator("aside").getByText("Synthetic advisory for browser verification.")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: fixture.assignedProjectName, level: 2 })).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect((await control(request, "state")).requestCount).toBe(0);
});

test("E: a MEMBER can report on an assigned project with only assigned task context", async ({ page, request }) => {
  const fixture = readFixtures();
  await signIn(page, fixture.memberEmail, fixture.password);
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("button", { name: fixture.assignedProjectName, exact: true }).click();
  await expect(page.getByRole("heading", { name: fixture.assignedProjectName, level: 2 })).toBeVisible();
  await page.getByRole("button", { name: "Generate report", exact: true }).click();
  await expect(page.locator("aside").getByText("Synthetic advisory for browser verification.")).toBeVisible();

  const state = await control(request, "state");
  expect(state.requestCount).toBe(1);
  expect(state.lastMetadata).toMatchObject({ memberTaskPresent: true, ownerTaskAbsent: true, privateFileSentinelAbsent: true, privateMeetingSentinelAbsent: true });
});

test("F: a MEMBER cannot report on an unassigned same-agency project", async ({ page, request }) => {
  const fixture = readFixtures();
  await signIn(page, fixture.memberEmail, fixture.password);
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("button", { name: fixture.unassignedProjectName, exact: true })).toHaveCount(0);

  const result = await browserPostHealthReport(page, fixture.unassignedProjectId);
  expect(result.status).toBe(404);
  expect(result.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  expect((await control(request, "state")).requestCount).toBe(0);
});

test("G: an owner cannot report on another tenant project", async ({ page, request }) => {
  const fixture = readFixtures();
  await signIn(page, fixture.ownerEmail, fixture.password);
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("button", { name: fixture.otherTenantProjectName, exact: true })).toHaveCount(0);

  const result = await browserPostHealthReport(page, fixture.otherTenantProjectId);
  expect(result.status).toBe(404);
  expect(result.body).toMatchObject({ error: { code: "NOT_FOUND" } });
  expect(JSON.stringify(result.body)).not.toContain(fixture.otherTenantProjectName);
  expect((await control(request, "state")).requestCount).toBe(0);
});

test("H: report generation leaves project and task statuses unchanged", async ({ page, request }) => {
  const fixture = readFixtures();
  const taskIds = [fixture.otherTenantTaskId];
  const before = await readProjectState(fixture.otherTenantProjectId, taskIds);
  await signIn(page, fixture.otherOwnerEmail, fixture.password);
  await openProject(page, fixture.otherTenantProjectName);
  await page.getByRole("button", { name: "Generate report", exact: true }).click();
  await expect(page.locator("aside").getByText("Synthetic advisory for browser verification.")).toBeVisible();
  const after = await readProjectState(fixture.otherTenantProjectId, taskIds);
  expect(after).toEqual(before);
  expect((await control(request, "state")).requestCount).toBe(1);
});

test("unauthenticated and missing-CSRF report requests are rejected before the provider", async ({ page, request }) => {
  const fixture = readFixtures();
  await page.goto("/login");
  const unauthenticated = await browserPostHealthReport(page, fixture.assignedProjectId);
  expect(unauthenticated.status).toBe(401);

  await signIn(page, fixture.ownerEmail, fixture.password);
  const csrfRejected = await browserPostHealthReport(page, fixture.assignedProjectId, false);
  expect(csrfRejected.status).toBe(403);
  expect((await control(request, "state")).requestCount).toBe(0);
});

async function readProjectState(projectId, taskIds) {
  const prisma = new PrismaClient();
  try {
    const [project, tasks] = await Promise.all([
      prisma.project.findUnique({ where: { id: projectId }, select: { status: true } }),
      prisma.task.findMany({ where: { id: { in: taskIds } }, orderBy: { id: "asc" }, select: { id: true, status: true } })
    ]);
    return { project, tasks };
  } finally {
    await prisma.$disconnect();
  }
}