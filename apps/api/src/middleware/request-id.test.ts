import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { requestId } from "./request-id.js";

const servers: Array<ReturnType<ReturnType<typeof express>['listen']>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function startServer() {
  const app = express();
  app.use(requestId);
  app.get("/", (request, response) => response.json({ requestId: request.id }));
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("request ID middleware", () => {
  it("propagates a valid incoming request ID", async () => {
    const response = await fetch(await startServer(), { headers: { "x-request-id": "client-request-123" } });
    const body = await response.json() as { requestId: string };
    expect(response.headers.get("x-request-id")).toBe("client-request-123");
    expect(body.requestId).toBe("client-request-123");
  });

  it("generates an ID when absent and replaces invalid values", async () => {
    const baseUrl = await startServer();
    for (const headers of [{}, { "x-request-id": "bad id value" }, { "x-request-id": "x".repeat(129) }]) {
      const response = await fetch(baseUrl, { headers });
      const requestIdValue = response.headers.get("x-request-id");
      expect(requestIdValue).toMatch(/^[0-9a-f-]{36}$/);
      expect((await response.json()).requestId).toBe(requestIdValue);
    }
  });
});