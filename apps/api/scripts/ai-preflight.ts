import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { inspectAiPreflightConfiguration } from "../src/config/ai-preflight.js";

const envFile = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find(existsSync);
if (envFile) config({ path: envFile });

const configuration = inspectAiPreflightConfiguration(process.env);
console.info("AI PREFLIGHT (configuration only; no network request)");
console.info(`AI_PROVIDER: ${configuration.provider}`);
console.info(`AI_API_KEY: ${configuration.apiKey}`);
console.info(`AI_MODEL: ${configuration.model}`);
console.info(`AI_TIMEOUT_MS: ${configuration.timeoutMs}ms${configuration.timeout === "INVALID" ? " (INVALID CONFIGURATION)" : ""}`);

if (!configuration.readyToProbe) {
  const missing = [
    configuration.provider === "NOT SET" ? "AI_PROVIDER" : configuration.provider === "INVALID" ? "AI_PROVIDER (unsupported)" : null,
    configuration.apiKey === "NOT SET" ? "AI_API_KEY" : null,
    configuration.model === "NOT SET" ? "AI_MODEL" : null,
    configuration.timeout === "INVALID" ? "AI_TIMEOUT_MS (must be an integer from 1000 to 60000)" : null
  ].filter(Boolean);
  console.error("\nRESULT: NOT CONFIGURED");
  console.error("Human action required:");
  for (const setting of missing) console.error(`- Configure ${setting} securely.`);
  process.exitCode = 1;
} else {
  console.info("\nConfiguration: PASS");
  console.info("Live provider availability: NOT CHECKED");
  console.info("\nRESULT: CONFIGURED — LIVE PROVIDER NOT CHECKED");
}