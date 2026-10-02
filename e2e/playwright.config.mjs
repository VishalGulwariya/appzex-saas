import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

const requireFromApi = createRequire(resolve(process.cwd(), "apps/api/package.json"));
const { config: loadDotenv } = requireFromApi("dotenv");

if (process.env.NODE_ENV === "production") {
  throw new Error("E2E refuses to run when the parent process is configured for production");
}
process.env.NODE_ENV = "test";
loadDotenv({ path: resolve(process.cwd(), ".env") });

let databaseTarget;
try {
  databaseTarget = new URL(process.env.DATABASE_URL ?? "");
} catch {
  throw new Error("E2E requires a valid local DATABASE_URL");
}
if (databaseTarget.protocol !== "mysql:" || !["localhost", "127.0.0.1", "::1"].includes(databaseTarget.hostname) || databaseTarget.pathname.slice(1) !== "appzex") {
  throw new Error("E2E refuses database targets other than the established local appzex test database");
}
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error("E2E requires a valid local SESSION_SECRET");
}

const webOrigin = "http://localhost:3000";
const apiOrigin = "http://127.0.0.1:4300";
const providerOrigin = "http://127.0.0.1:4400";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  globalSetup: "./global-setup.mjs",
  globalTeardown: "./global-teardown.mjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: "list",
  outputDir: "../test-results",
  use: {
    baseURL: webOrigin,
    browserName: "chromium",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off"
  },
  webServer: [
    {
      command: "node e2e/provider-mock.mjs",
      cwd: process.cwd(),
      url: `${providerOrigin}/__health`,
      reuseExistingServer: false,
      timeout: 30000,
      env: { E2E_PROVIDER_PORT: "4400" }
    },
    {
      command: "npm run dev --workspace @appzex/api",
      cwd: process.cwd(),
      url: `${apiOrigin}/api/v1/health`,
      reuseExistingServer: false,
      timeout: 120000,
      env: {
        NODE_ENV: "test",
        API_PORT: "4300",
        WEB_ORIGIN: webOrigin,
        DATABASE_URL: process.env.DATABASE_URL,
        SESSION_SECRET: process.env.SESSION_SECRET,
        AI_PROVIDER: "openai",
        AI_API_KEY: randomBytes(32).toString("base64url"),
        AI_MODEL: "e2e-mock-model",
        AI_TIMEOUT_MS: "20000",
        AI_TEST_PROVIDER_URL: `${providerOrigin}/v1/responses`,
        // The suite signs in repeatedly across specs; the production default of 10 per window
        // would throttle later specs. This only affects the local test process.
        AUTH_LOGIN_RATE_LIMIT: "200",
        AI_REPORT_RATE_LIMIT: "50"
      }
    },
    {
      command: "npm run dev --workspace @appzex/web",
      cwd: process.cwd(),
      url: webOrigin,
      reuseExistingServer: false,
      timeout: 120000,
      env: {
        NODE_ENV: "development",
        PORT: "3000",
        API_INTERNAL_URL: apiOrigin
      }
    }
  ]
});
