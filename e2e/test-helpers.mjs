import { readFileSync } from "node:fs";
import { fixtureFile } from "./paths.mjs";

export function readFixtures() {
  return JSON.parse(readFileSync(fixtureFile, "utf8"));
}

export async function signIn(page, email, password) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/agency");
  await page.getByText("AGENCY OPERATIONS", { exact: true }).waitFor();
}

export async function openProject(page, projectName) {
  await page.getByRole("button", { name: "Projects", exact: true }).click();
  await page.getByRole("button", { name: projectName, exact: true }).click();
  await page.getByRole("heading", { name: projectName, level: 2 }).waitFor();
}

export async function control(request, action, mode) {
  const base = "http://127.0.0.1:4400/__control";
  const response = action === "state"
    ? await request.get(`${base}/state`)
    : await request.post(`${base}/${action}`, { data: action === "reset" ? { mode } : {} });
  if (!response.ok()) throw new Error(`E2E provider control failed with ${response.status()}`);
  return response.json();
}