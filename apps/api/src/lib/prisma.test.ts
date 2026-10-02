import { describe, expect, it } from "vitest";
import { withPrismaPoolDefaults } from "./prisma.js";

describe("Prisma connection pool URL defaults", () => {
  it("adds explicit bounded pool and connection timeouts while preserving the URL", () => {
    const result = new URL(withPrismaPoolDefaults("mysql://user:p%40ss@localhost:3306/appzex?charset=utf8mb4"));
    expect(result.searchParams.get("connection_limit")).toBe("10");
    expect(result.searchParams.get("pool_timeout")).toBe("20");
    expect(result.searchParams.get("connect_timeout")).toBe("10");
    expect(result.searchParams.get("socket_timeout")).toBe("30");
    expect(result.searchParams.get("charset")).toBe("utf8mb4");
  });

  it("preserves explicitly configured pool parameters", () => {
    const result = new URL(withPrismaPoolDefaults("mysql://localhost:3306/appzex?connection_limit=5&pool_timeout=7"));
    expect(result.searchParams.get("connection_limit")).toBe("5");
    expect(result.searchParams.get("pool_timeout")).toBe("7");
  });
});