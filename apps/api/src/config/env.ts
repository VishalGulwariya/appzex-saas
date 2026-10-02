import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { z } from "zod";

const envFile = [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")].find(existsSync);
if (envFile) config({ path: envFile });

function isDatabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.protocol && url.hostname && url.pathname.length > 1 && !["http:", "https:"].includes(url.protocol));
  } catch {
    return false;
  }
}

function normalizeWebOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.string().optional(),
  DATABASE_URL: z.string().trim().min(1, "DATABASE_URL is required").refine(isDatabaseUrl, "must be a valid database connection URL"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters").refine((value) => value !== "replace_with_at_least_32_random_characters", "replace the example value with a random secret"),
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  FILE_STORAGE_PATH: z.string().trim().min(1).default("./private-uploads"),
  AI_PROVIDER: z.string().trim().optional().transform((value) => value || undefined).pipe(z.enum(["openai"]).optional()),
  AI_API_KEY: z.string().trim().optional().transform((value) => value || undefined),
  AI_MODEL: z.string().trim().optional().transform((value) => value || undefined),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(20000),
  AI_TEST_PROVIDER_URL: z.string().trim().optional().transform((value) => value || undefined),
  AUTH_LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),
  AI_REPORT_RATE_LIMIT: z.coerce.number().int().min(1).max(1000).default(5)
}).superRefine((value, context) => {
  const webOrigin = value.WEB_ORIGIN === undefined ? null : normalizeWebOrigin(value.WEB_ORIGIN);
  if (value.NODE_ENV === "production" && value.WEB_ORIGIN === undefined) {
    context.addIssue({ code: "custom", path: ["WEB_ORIGIN"], message: "is required in production" });
  } else if (value.WEB_ORIGIN !== undefined && !webOrigin) {
    context.addIssue({ code: "custom", path: ["WEB_ORIGIN"], message: "must be an origin URL without credentials, path, query, or fragment" });
  }
  if (value.NODE_ENV === "production" && webOrigin) {
    const originUrl = new URL(webOrigin);
    if (originUrl.protocol !== "https:") {
      context.addIssue({ code: "custom", path: ["WEB_ORIGIN"], message: "must use HTTPS in production" });
    }
    if (isLoopbackHost(originUrl.hostname)) {
      context.addIssue({ code: "custom", path: ["WEB_ORIGIN"], message: "must not use a loopback host in production" });
    }
  }

  if (value.AI_PROVIDER === "openai") {
    if (!value.AI_API_KEY) context.addIssue({ code: "custom", path: ["AI_API_KEY"], message: "is required when AI_PROVIDER=openai" });
    if (!value.AI_MODEL) context.addIssue({ code: "custom", path: ["AI_MODEL"], message: "is required when AI_PROVIDER=openai" });
  }
  if (value.AI_TEST_PROVIDER_URL) {
    let testProviderUrl: URL | undefined;
    try { testProviderUrl = new URL(value.AI_TEST_PROVIDER_URL); } catch { /* Report the safe validation issue below. */ }
    if (value.NODE_ENV !== "test") {
      context.addIssue({ code: "custom", path: ["AI_TEST_PROVIDER_URL"], message: "is only available when NODE_ENV=test" });
    } else if (!testProviderUrl || testProviderUrl.protocol !== "http:" || !isLoopbackHost(testProviderUrl.hostname) || testProviderUrl.username || testProviderUrl.password || testProviderUrl.pathname !== "/v1/responses" || testProviderUrl.search || testProviderUrl.hash) {
      context.addIssue({ code: "custom", path: ["AI_TEST_PROVIDER_URL"], message: "must be a loopback HTTP /v1/responses URL without credentials, query, or fragment" });
    }
  }

  const cookieSecure = value.COOKIE_SECURE === undefined
    ? value.NODE_ENV === "production"
    : value.COOKIE_SECURE === "true";
  if (value.NODE_ENV === "production" && !cookieSecure) {
    context.addIssue({ code: "custom", path: ["COOKIE_SECURE"], message: "must be true in production" });
  }
  if (value.COOKIE_SAME_SITE === "none" && !cookieSecure) {
    context.addIssue({ code: "custom", path: ["COOKIE_SECURE"], message: "must be true when COOKIE_SAME_SITE=none" });
  }
}).transform((value) => ({
  ...value,
  WEB_ORIGIN: value.WEB_ORIGIN === undefined ? "http://localhost:3000" : normalizeWebOrigin(value.WEB_ORIGIN)!,
  COOKIE_SECURE: value.COOKIE_SECURE === undefined ? value.NODE_ENV === "production" : value.COOKIE_SECURE === "true"
}));

export function parseEnvironment(source: NodeJS.ProcessEnv) {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map(({ path, message }) => `${path.join(".")}: ${message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

export const env = parseEnvironment(process.env);



