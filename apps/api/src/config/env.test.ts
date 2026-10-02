import { describe, expect, it } from "vitest";
import { parseEnvironment } from "./env.js";

const baseEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "development",
  DATABASE_URL: "mysql://localhost:3306/appzex?connection_limit=5&connect_timeout=10",
  SESSION_SECRET: "x".repeat(40)
};

function parse(overrides: NodeJS.ProcessEnv = {}) {
  return parseEnvironment({ ...baseEnvironment, ...overrides });
}

describe("API environment contract", () => {
  it("preserves development defaults", () => {
    const environment = parse();
    expect(environment.WEB_ORIGIN).toBe("http://localhost:3000");
    expect(environment.COOKIE_SECURE).toBe(false);
    expect(environment.COOKIE_SAME_SITE).toBe("lax");
    expect(environment.SESSION_TTL_DAYS).toBe(7);
    expect(environment.AI_TIMEOUT_MS).toBe(20000);
  });

  it("requires an explicit recognized NODE_ENV", () => {
    expect(() => parse({ NODE_ENV: undefined })).toThrow(/NODE_ENV/);
    expect(() => parse({ NODE_ENV: "staging" })).toThrow(/NODE_ENV/);
  });

  it("requires a non-local HTTPS origin in production and defaults cookies to secure", () => {
    expect(() => parse({ NODE_ENV: "production" })).toThrow(/WEB_ORIGIN: is required in production/);
    expect(() => parse({ NODE_ENV: "production", WEB_ORIGIN: "http://localhost:3000" })).toThrow(/WEB_ORIGIN/);
    const environment = parse({ NODE_ENV: "production", WEB_ORIGIN: "https://app.example.test" });
    expect(environment.WEB_ORIGIN).toBe("https://app.example.test");
    expect(environment.COOKIE_SECURE).toBe(true);
  });

  it("rejects insecure production cookie settings", () => {
    expect(() => parse({ NODE_ENV: "production", WEB_ORIGIN: "https://app.example.test", COOKIE_SECURE: "false" })).toThrow(/COOKIE_SECURE/);
    expect(() => parse({ NODE_ENV: "development", COOKIE_SECURE: "false", COOKIE_SAME_SITE: "none" })).toThrow(/COOKIE_SECURE/);
  });

  it("accepts disabled AI configuration and requires complete OpenAI configuration when enabled", () => {
    expect(parse().AI_PROVIDER).toBeUndefined();
    expect(() => parse({ AI_PROVIDER: "openai", AI_API_KEY: "synthetic-key-value" })).toThrow(/AI_MODEL/);
    expect(() => parse({ AI_PROVIDER: "openai", AI_MODEL: "synthetic-model" })).toThrow(/AI_API_KEY/);
    expect(parse({ AI_PROVIDER: "openai", AI_API_KEY: "synthetic-key-value", AI_MODEL: "synthetic-model" }).AI_PROVIDER).toBe("openai");
  });

  it("restricts the provider mock URL to loopback test mode", () => {
    expect(parse({ NODE_ENV: "test", AI_PROVIDER: "openai", AI_API_KEY: "synthetic-key-value", AI_MODEL: "synthetic-model", AI_TEST_PROVIDER_URL: "http://127.0.0.1:4400/v1/responses" }).AI_TEST_PROVIDER_URL).toBe("http://127.0.0.1:4400/v1/responses");
    expect(parse({ NODE_ENV: "test", AI_PROVIDER: "openai", AI_API_KEY: "synthetic-key-value", AI_MODEL: "synthetic-model" }).AI_TEST_PROVIDER_URL).toBeUndefined();
    expect(() => parse({ NODE_ENV: "production", AI_TEST_PROVIDER_URL: "http://127.0.0.1:4400/v1/responses" })).toThrow(/NODE_ENV=test/);
    expect(() => parse({ NODE_ENV: "test", AI_TEST_PROVIDER_URL: "https://external.example.test/v1/responses" })).toThrow(/loopback HTTP/);
  });

  it("preserves valid connection URL query parameters", () => {
    const databaseUrl = "mysql://user:p%40ss@db.example.test:3306/appzex?connection_limit=5&connect_timeout=10";
    expect(parse({ DATABASE_URL: databaseUrl }).DATABASE_URL).toBe(databaseUrl);
  });

  it("rejects malformed database URLs without echoing their contents", () => {
    const marker = "sensitive-marker";
    let message = "";
    try {
      parse({ DATABASE_URL: `not-a-url-${marker}` });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("DATABASE_URL: must be a valid database connection URL");
    expect(message).not.toContain(marker);
  });
});