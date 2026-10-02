import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { AgencyRole, GlobalRole } from "@prisma/client";
import type { RequestAuthContext } from "../types/express.js";
import { createAiRateLimiter } from "./ai-rate-limiter.js";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function startServer(now: () => number) {
  const app = express();
  app.use((request, _response, next) => {
    request.auth = {
      userId: request.get("x-test-user") ?? "test-user",
      globalRole: GlobalRole.USER,
      portal: "agency",
      sessionId: "test-session",
      agencyId: request.get("x-test-tenant") ?? "tenant-a",
      agencyRole: AgencyRole.OWNER
    } satisfies RequestAuthContext;
    next();
  });
  app.post("/health-report", createAiRateLimiter({ limit: 5, windowMs: 600000, now }), (_request, response) => {
    response.status(200).json({ accepted: true });
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/health-report`;
}

describe("AI health-report rate limiter", () => {
  it("limits five requests per tenant across users and returns a sanitized 429", async () => {
    let timestamp = 1000;
    const url = await startServer(() => timestamp);
    for (let index = 0; index < 5; index += 1) {
      const response = await fetch(url, { method: "POST", headers: { "x-test-user": `user-${index}` } });
      expect(response.status).toBe(200);
    }
    const limited = await fetch(url, { method: "POST", headers: { "x-test-user": "another-user" } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("600");
    expect(await limited.json()).toEqual({ error: {
      code: "RATE_LIMIT_EXCEEDED",
      message: "Health report generation limit exceeded. Please try again later."
    } });

    timestamp += 600001;
    const afterWindow = await fetch(url, { method: "POST", headers: { "x-test-user": "another-user" } });
    expect(afterWindow.status).toBe(200);
  });

  it("falls back to a user bucket when tenant context is absent", async () => {
    const app = express();
    const limiter = createAiRateLimiter({ limit: 1, windowMs: 600000 });
    app.use((request, _response, next) => {
      request.auth = { userId: "fallback-user", globalRole: GlobalRole.USER, portal: "selection", sessionId: "test-session" };
      next();
    });
    app.post("/health-report", limiter, (_request, response) => response.sendStatus(200));
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health-report`;
    expect((await fetch(url, { method: "POST" })).status).toBe(200);
    expect((await fetch(url, { method: "POST" })).status).toBe(429);
  });
});
