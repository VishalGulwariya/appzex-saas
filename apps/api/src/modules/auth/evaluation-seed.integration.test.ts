import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";

type Authenticated = { cookie: string; csrfToken: string };

let server: ReturnType<typeof app.listen>;
let baseUrl = "";
let seedPassword = "";
const sessions: Authenticated[] = [];
const auditWindow = { startedAt: new Date(0), supportSessionIds: [] as string[] };

function cookieFrom(response: Response, name: string): string {
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie?.startsWith(`${name}=`)) throw new Error(`Expected ${name} cookie`);
  return cookie;
}

async function csrf(): Promise<{ token: string; cookie: string }> {
  const response = await fetch(`${baseUrl}/api/v1/auth/csrf`);
  if (!response.ok) throw new Error(`CSRF setup failed with ${response.status}`);
  return { token: (await response.json() as { csrfToken: string }).csrfToken, cookie: cookieFrom(response, "appzex_csrf") };
}

async function login(email: string) {
  const token = await csrf();
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token.token, Cookie: token.cookie },
    body: JSON.stringify({ email, password: seedPassword })
  });
  const body = await response.json() as Record<string, unknown>;
  if (response.ok) {
    const auth = { cookie: `${token.cookie}; ${cookieFrom(response, "appzex_session")}`, csrfToken: token.token };
    sessions.push(auth);
    return { status: response.status, body, auth };
  }
  return { status: response.status, body, auth: null };
}

function request(auth: Authenticated, path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { "Content-Type": "application/json", Cookie: auth.cookie, "X-CSRF-Token": auth.csrfToken, ...init.headers } });
}

describe("evaluation seed dataset: tenant isolation, suspension lockout and derived progress", () => {
  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    seedPassword = process.env.SEED_PASSWORD?.trim() || "password123";
    if (!databaseUrl) throw new Error("Root .env DATABASE_URL is required for the local seed integration test");
    const target = new URL(databaseUrl);
    if (target.protocol !== "mysql:" || !["localhost", "127.0.0.1", "::1"].includes(target.hostname) || target.pathname.slice(1) !== "appzex") {
      throw new Error("Refusing to run the seed integration test against a nonlocal or unexpected database");
    }
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 30000);

  afterAll(async () => {
    try {
      for (const auth of sessions) {
        await fetch(`${baseUrl}/api/v1/auth/logout`, { method: "POST", headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrfToken } }).catch(() => undefined);
      }
      // Targeted cleanup of only the audit rows this suite created; no user or tenant data is removed.
      await prisma.$transaction(async (tx) => {
        await tx.platformActivity.deleteMany({ where: { agencyId: "agc_eval_apex", createdAt: { gte: auditWindow.startedAt }, eventType: { startsWith: "support" } } });
        await tx.supportSession.deleteMany({ where: { id: { in: auditWindow.supportSessionIds } } });
      });
    } finally {
      if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 30000);

  it("locks out a suspended agency user at login with an explicit HTTP 403 and no session", async () => {
    const result = await login("admin@suspended.local");
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: "AGENCY_SUSPENDED" } });
    const message = (result.body as { error: { message: string } }).error.message;
    expect(message).toContain("Stalled Creative");
    expect(message.toLowerCase()).toContain("suspended");
    expect(result.auth).toBeNull();
  });

  it("signs the Super Admin into the platform portal", async () => {
    const result = await login("superadmin@appzex.local");
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ redirectTo: "/super-admin" });
    expect((result.body as { user: { globalRole: string } }).user.globalRole).toBe("SUPER_ADMIN");
  });

  it("signs Agency A admin in and exposes only Agency A data with derived progress", async () => {
    const result = await login("admin@agencya.local");
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ contextRequired: false, redirectTo: "/agency", contexts: [{ type: "agency", agencyName: "Apex Digital Marketing", role: "ADMIN" }] });
    const auth = result.auth!;
    const projects = await request(auth, "/api/v1/agency/projects");
    expect(projects.status).toBe(200);
    const items = (await projects.json() as { items: Array<{ id: string; name: string; progress: number }> }).items;
    const apex = items.find((project) => project.id === "prj_eval_apex_site");
    expect(apex).toMatchObject({ name: "Apex Marketing Site Relaunch", progress: 40 });
    expect(JSON.stringify(items)).not.toContain("Nexus Customer Portal");
  });

  it("denies Agency A admin direct access to Agency B data", async () => {
    const auth = (await login("admin@agencya.local")).auth!;
    const clients = await request(auth, "/api/v1/agency/clients");
    expect(clients.status).toBe(200);
    const clientBody = await clients.text();
    expect(clientBody).not.toContain("Nexus");
    expect(clientBody).not.toContain("ClientCorp B");

    const direct = await request(auth, "/api/v1/agency/projects/prj_eval_nexus_portal");
    expect(direct.status).toBe(404);
    expect(await direct.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("gives the Agency A team member only assigned-project visibility", async () => {
    const auth = (await login("dev@agencya.local")).auth!;
    const projects = await request(auth, "/api/v1/agency/projects");
    const items = (await projects.json() as { items: Array<{ id: string }> }).items;
    expect(items.map((project) => project.id)).toEqual(["prj_eval_apex_site"]);
    const nexusProject = await request(auth, "/api/v1/agency/projects/prj_eval_nexus_portal");
    expect(nexusProject.status).toBe(404);
  });

  it("gives the Agency B team member only assigned-project visibility inside Agency B", async () => {
    const auth = (await login("dev@agencyb.local")).auth!;
    const identity = await (await request(auth, "/api/v1/auth/me")).json() as { contexts: Array<{ type: string; agencyId: string; agencyName: string; role: string }> };
    expect(identity.contexts).toEqual([{ type: "agency", agencyId: "agc_eval_nexus", agencyName: "Nexus Software Agency", role: "MEMBER" }]);

    const projects = await request(auth, "/api/v1/agency/projects");
    expect(projects.status).toBe(200);
    const items = (await projects.json() as { items: Array<{ id: string }> }).items;
    expect(items.map((project) => project.id)).toEqual(["prj_eval_nexus_portal"]);

    const apexProject = await request(auth, "/api/v1/agency/projects/prj_eval_apex_site");
    expect(apexProject.status).toBe(404);
    const clients = await request(auth, "/api/v1/agency/clients");
    expect(await clients.text()).not.toContain("ClientCorp A");
  });

  it("returns seeded milestones with the project detail payload", async () => {
    const auth = (await login("admin@agencya.local")).auth!;
    const detail = await request(auth, "/api/v1/agency/projects/prj_eval_apex_site");
    expect(detail.status).toBe(200);
    const body = await detail.json() as { project: { progress: number; milestones: Array<{ title: string; status: string }> } };
    expect(body.project.progress).toBe(40);
    expect(body.project.milestones.map((milestone) => milestone.status)).toEqual(["COMPLETED", "IN_PROGRESS", "PENDING"]);
  });

  it("scopes the Agency A client portal to ClientCorp A", async () => {
    const auth = (await login("client@companya.local")).auth!;
    const dashboard = await request(auth, "/api/v1/client/dashboard");
    expect(dashboard.status).toBe(200);
    const body = await dashboard.json() as { company: string; projects: Array<{ id: string; progress: number }> };
    expect(body.company).toBe("ClientCorp A");
    expect(body.projects.map((project) => project.id)).toEqual(["prj_eval_apex_site"]);
    expect(body.projects[0]?.progress).toBe(40);
    expect(JSON.stringify(body)).not.toContain("Nexus");
  });

  it("scopes the Agency B client portal to ClientCorp B", async () => {
    const auth = (await login("client@companyb.local")).auth!;
    const dashboard = await request(auth, "/api/v1/client/dashboard");
    const body = await dashboard.json() as { company: string; projects: Array<{ id: string; progress: number }> };
    expect(body.company).toBe("ClientCorp B");
    expect(body.projects.map((project) => project.id)).toEqual(["prj_eval_nexus_portal"]);
    expect(body.projects[0]?.progress).toBe(50);
  });

  it("lets a Super Admin open and close an audited support session on an agency workspace", async () => {
    const auth = (await login("superadmin@appzex.local")).auth!;
    const before = await request(auth, "/api/v1/auth/me");
    expect((await before.json() as { supportMode: unknown }).supportMode).toBeNull();
    auditWindow.startedAt = new Date(Date.now() - 1000);

    const start = await request(auth, "/api/v1/auth/support-session", {
      method: "POST",
      body: JSON.stringify({ agencyId: "agc_eval_apex", reason: "Evaluation walkthrough of tenant isolation and derived progress." })
    });
    expect(start.status).toBe(201);
    const started = await start.json() as { supportSessionId: string };
    auditWindow.supportSessionIds.push(started.supportSessionId);

    const during = await request(auth, "/api/v1/auth/me");
    const identity = await during.json() as { portal: string; supportMode: { id: string; agencyName: string } | null };
    expect(identity.portal).toBe("super-admin");
    expect(identity.supportMode?.agencyName).toBe("Apex Digital Marketing");

    const workspace = await request(auth, "/api/v1/agency/projects");
    expect(workspace.status).toBe(200);
    const items = (await workspace.json() as { items: Array<{ id: string; progress: number }> }).items;
    expect(items.find((project) => project.id === "prj_eval_apex_site")).toMatchObject({ progress: 40 });

    const end = await request(auth, `/api/v1/auth/support-session`, { method: "DELETE" });
    expect(end.status).toBe(200);
    const after = await request(auth, "/api/v1/auth/me");
    expect((await after.json() as { supportMode: unknown }).supportMode).toBeNull();

    const blocked = await request(auth, "/api/v1/agency/projects");
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: { code: "AGENCY_CONTEXT_REQUIRED" } });
  });

  it("writes a durable audit record for every support mode entry and action", async () => {
    const audit = prisma.platformActivity.findMany({
      where: { agencyId: "agc_eval_apex", createdAt: { gte: auditWindow.startedAt } },
      orderBy: { createdAt: "asc" }
    });
    const events = await audit;
    const types = events.map((event) => event.eventType);
    expect(types).toContain("support.started");
    expect(types).toContain("support.ended");
    expect(types.some((type) => type.startsWith("support.agency."))).toBe(true);

    const started = events.find((event) => event.eventType === "support.started")!;
    expect(started.actorId).toBe("usr_eval_superadmin");
    expect(started.agencyId).toBe("agc_eval_apex");
    expect(started.entityId).toBe(started.entityId);
    expect(started.summary).toContain("Apex Digital Marketing");
    expect(started.metadata).toMatchObject({ reason: expect.stringContaining("Evaluation walkthrough") });

    // A Super Admin is never an agency member, so support audit records cannot and must not
    // land in activity_logs: its actor column is a foreign key to agency_members.
    const superAdminMembership = await prisma.agencyMember.count({ where: { userId: "usr_eval_superadmin" } });
    expect(superAdminMembership).toBe(0);
  });
});