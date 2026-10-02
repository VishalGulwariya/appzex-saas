import { describe, expect, it } from "vitest";
import { resolveApiInternalUrl } from "./next.config";

describe("Next.js API rewrite configuration", () => {
  it("uses the localhost API fallback outside production", () => {
    expect(resolveApiInternalUrl({ NODE_ENV: "development" })).toBe("http://localhost:4000");
  });

  it("requires an explicit non-loopback API origin in production", () => {
    expect(() => resolveApiInternalUrl({ NODE_ENV: "production" })).toThrow(/required in production/);
    expect(() => resolveApiInternalUrl({ NODE_ENV: "production", API_INTERNAL_URL: "http://localhost:4000" })).toThrow(/loopback/);
    expect(() => resolveApiInternalUrl({ NODE_ENV: "production", API_INTERNAL_URL: "http://[::1]:4000" })).toThrow(/loopback/);
    expect(resolveApiInternalUrl({ NODE_ENV: "production", API_INTERNAL_URL: "https://api.internal.example.test" })).toBe("https://api.internal.example.test");
  });

  it("rejects malformed URLs and embedded credentials", () => {
    expect(() => resolveApiInternalUrl({ NODE_ENV: "development", API_INTERNAL_URL: "not a URL" })).toThrow(/valid HTTP or HTTPS URL/);
    expect(() => resolveApiInternalUrl({ NODE_ENV: "development", API_INTERNAL_URL: "https://user:pass@api.example.test" })).toThrow(/without credentials/);
  });
});