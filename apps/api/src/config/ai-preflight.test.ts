import { describe, expect, it } from "vitest";
import { inspectAiPreflightConfiguration } from "./ai-preflight.js";

describe("AI preflight configuration inspection", () => {
  it("reports missing settings without exposing values", () => {
    const result = inspectAiPreflightConfiguration({ AI_TIMEOUT_MS: "20000" });
    expect(result).toEqual({ provider: "NOT SET", apiKey: "NOT SET", model: "NOT SET", timeout: "VALID", timeoutMs: 20000, readyToProbe: false });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });

  it("is ready only for the supported provider and complete configuration", () => {
    expect(inspectAiPreflightConfiguration({ AI_PROVIDER: "openai", AI_API_KEY: "synthetic-secret", AI_MODEL: "synthetic-model", AI_TIMEOUT_MS: "20000" }).readyToProbe).toBe(true);
    expect(inspectAiPreflightConfiguration({ AI_PROVIDER: "other", AI_API_KEY: "synthetic-secret", AI_MODEL: "synthetic-model" }).provider).toBe("INVALID");
    expect(inspectAiPreflightConfiguration({ AI_PROVIDER: "openai", AI_API_KEY: "synthetic-secret" }).readyToProbe).toBe(false);
  });

  it.each(["abc", "0", "-1", "999", "60001"]) ("rejects invalid timeout %s", (timeout) => {
    expect(inspectAiPreflightConfiguration({ AI_PROVIDER: "openai", AI_API_KEY: "synthetic-secret", AI_MODEL: "synthetic-model", AI_TIMEOUT_MS: timeout }).timeout).toBe("INVALID");
  });
});