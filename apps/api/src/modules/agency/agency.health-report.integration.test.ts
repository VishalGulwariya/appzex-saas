import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { AgencyRole, FeedbackStatus, MilestoneStatus, Priority, ProjectStatus, TaskStatus } from "@prisma/client";

const { providerGenerate } = vi.hoisted(() => ({ providerGenerate: vi.fn() }));
vi.mock("../ai/project-health.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai/project-health.js")>();
  return {
    ...actual,
    generateHealthReport: (context: Parameters<typeof actual.generateHealthReport>[0]) =>
      actual.generateHealthReport(context, undefined, { generate: providerGenerate })
  };
});

import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { AiProviderError } from "../ai/project-health.js";

const validReport = {
  health: "NEEDS_ATTENTION" as const,
  summary: "Review the delayed work and upcoming milestone.",
  risks: [{ severity: "MEDIUM" as const, title: "Overdue work", evidence: "An incomplete task is past due." }],
  recommendedActions: ["Review the task owner and revised date."]
};

type Authenticated = { cookie: string; csrfToken: string };
let server: ReturnType<typeof app.listen>;
let baseUrl = "";
let testPassword = "";
let memberEmail = "";
let memberAssignedProjectId = "";
let memberUnassignedProjectId = "";
const sessions: Authenticated[] = [];
const temporaryIds: { user: string[]; project: string[]; task: string[]; milestone: string[]; feedback: string[]; activity: string[]; meeting: string[]; file: string[] } = {
  user: [], project: [], task: [], milestone: [], feedback: [], activity: [], meeting: [], file: []
};

function cookieFrom(response: Response, name: string): string {
  const raw = response.headers.get("set-cookie") ?? "";
  const cookie = raw.split(";")[0];
  if (!cookie?.startsWith(`${name}=`)) throw new Error(`Expected ${name} cookie`);
  return cookie;
}

async function csrf(): Promise<{ token: string; cookie: string }> {
  const response = await fetch(`${baseUrl}/api/v1/auth/csrf`);
  if (!response.ok) throw new Error(`CSRF setup failed with ${response.status}`);
  const body = await response.json() as { csrfToken: string };
  return { token: body.csrfToken, cookie: cookieFrom(response, "appzex_csrf") };
}

const loginCache = new Map<string, Authenticated>();

async function login(email: string): Promise<Authenticated> {
  const cached = loginCache.get(email);
  if (cached) return cached;
  const token = await csrf();
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": token.token, Cookie: token.cookie },
    body: JSON.stringify({ email, password: testPassword })
  });
  if (!response.ok) throw new Error(`Login failed for a seeded test identity with ${response.status}`);
  const sessionCookie = cookieFrom(response, "appzex_session");
  const auth = { cookie: `${token.cookie}; ${sessionCookie}`, csrfToken: token.token };
  sessions.push(auth);
  loginCache.set(email, auth);
  return auth;
}

async function report(auth: Authenticated, projectId: string, options: { csrfToken?: string; cookie?: string } = {}) {
  return fetch(`${baseUrl}/api/v1/agency/projects/${projectId}/health-report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": options.csrfToken ?? auth.csrfToken,
      Cookie: options.cookie ?? auth.cookie
    },
    body: "{}"
  });
}

async function projectState(agencyId: string, projectId: string) {
  const [project, tasks, activityCount, feedback] = await Promise.all([
    prisma.project.findFirst({ where: { agencyId, id: projectId }, select: { status: true } }),
    prisma.task.findMany({ where: { agencyId, projectId }, orderBy: { id: "asc" }, select: { id: true, status: true } }),
    prisma.activityLog.count({ where: { agencyId, entityType: "project", entityId: projectId } }),
    prisma.feedback.findMany({ where: { agencyId, projectId }, orderBy: { id: "asc" }, select: { id: true, status: true } })
  ]);
  return { project, tasks, activityCount, feedback };
}

describe("mounted agency project health route with local MySQL and mocked provider", () => {
  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const seedPassword = process.env.SEED_PASSWORD?.trim() || "password123";
    if (!databaseUrl) throw new Error("Root .env DATABASE_URL is required for the local route integration test");
    const target = new URL(databaseUrl);
    if (target.protocol !== "mysql:" || !["localhost", "127.0.0.1", "::1"].includes(target.hostname) || target.pathname.slice(1) !== "appzex") {
      throw new Error("Refusing to run integration test against a nonlocal or unexpected database");
    }
    testPassword = seedPassword;
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const northstar = await prisma.project.findFirst({ where: { id: "project_northstar", agency: { slug: "northstar-studio" } }, select: { agencyId: true, clientId: true, managerId: true } });
    if (!northstar) throw new Error("Seeded Northstar project is missing");
    const seedOwner = await prisma.user.findUnique({ where: { email: "owner@northstar.test" }, select: { passwordHash: true } });
    if (!seedOwner) throw new Error("Seeded Northstar owner is missing");
    memberEmail = `phase9-member-${Date.now()}@appzex.test`;
    const member = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({ data: { name: "Phase 9 Member", email: memberEmail, passwordHash: seedOwner.passwordHash } });
      await tx.agencyMember.create({ data: { agencyId: northstar.agencyId, userId: created.id, role: AgencyRole.MEMBER } });
      return created;
    });
    temporaryIds.user.push(member.id);
    const dueSoon = new Date();
    dueSoon.setUTCDate(dueSoon.getUTCDate() + 7);
    dueSoon.setUTCHours(0, 0, 0, 0);
    const yesterday = new Date("2020-01-01T00:00:00.000Z");
    const fixtures = await prisma.$transaction(async (tx) => {
      const tasks = [];
      tasks.push(await tx.task.create({ data: { agencyId: northstar.agencyId, projectId: "project_northstar", title: "phase9-test-overdue-task", status: TaskStatus.IN_PROGRESS, priority: Priority.HIGH, dueDate: yesterday } }));
      tasks.push(await tx.task.create({ data: { agencyId: northstar.agencyId, projectId: "project_northstar", title: "phase9-test-future-task", status: TaskStatus.TODO, priority: Priority.MEDIUM, dueDate: new Date("2099-01-01T00:00:00.000Z") } }));
      tasks.push(await tx.task.create({ data: { agencyId: northstar.agencyId, projectId: "project_northstar", title: "phase9-test-completed-overdue-task", status: TaskStatus.DONE, priority: Priority.LOW, dueDate: yesterday } }));
      const milestone = await tx.milestone.create({ data: { agencyId: northstar.agencyId, projectId: "project_northstar", title: "phase9-test-upcoming-milestone", status: MilestoneStatus.PENDING, dueDate: dueSoon } });
      const feedback = [];
      feedback.push(await tx.feedback.create({ data: { agencyId: northstar.agencyId, projectId: "project_northstar", title: "phase9-test-open-feedback", description: "Approval is still pending.", status: FeedbackStatus.OPEN } }));
      feedback.push(await tx.feedback.create({ data: { agencyId: northstar.agencyId, projectId: "project_northstar", title: "phase9-test-resolved-feedback", description: "Already resolved.", status: FeedbackStatus.RESOLVED } }));
      const activity = await tx.activityLog.create({ data: { agencyId: northstar.agencyId, eventType: "phase9_test_recent_activity", entityType: "project", entityId: "project_northstar" } });
      const meeting = await tx.meeting.create({ data: { agencyId: northstar.agencyId, projectId: "project_northstar", title: "phase9-test-private-meeting", scheduledAt: new Date(), notes: "PRIVATE_MEETING_NOTES_SENTINEL", clientVisible: false } });
      const file = await tx.file.create({ data: { agencyId: northstar.agencyId, projectId: "project_northstar", storageKey: `phase9-test-${Date.now()}-private`, fileName: "PRIVATE_FILE_METADATA_SENTINEL.txt", mimeType: "text/plain", sizeBytes: 32n } });
      const assignedProject = await tx.project.create({ data: { agencyId: northstar.agencyId, clientId: northstar.clientId, managerId: northstar.managerId, name: "phase9-member-assigned-project", status: ProjectStatus.ACTIVE, priority: Priority.MEDIUM } });
      const unassignedProject = await tx.project.create({ data: { agencyId: northstar.agencyId, clientId: northstar.clientId, managerId: northstar.managerId, name: "phase9-member-unassigned-project", status: ProjectStatus.ACTIVE, priority: Priority.MEDIUM } });
      const memberTask = await tx.task.create({ data: { agencyId: northstar.agencyId, projectId: assignedProject.id, assigneeId: member.id, title: "phase9-test-member-assigned-task", status: TaskStatus.TODO, priority: Priority.MEDIUM } });
      return { taskIds: [...tasks.map((x) => x.id), memberTask.id], projectIds: [assignedProject.id, unassignedProject.id], assignedProjectId: assignedProject.id, unassignedProjectId: unassignedProject.id, milestoneId: milestone.id, feedbackIds: feedback.map((x) => x.id), activityId: activity.id, meetingId: meeting.id, fileId: file.id };
    });
    temporaryIds.project.push(...fixtures.projectIds);
    temporaryIds.task.push(...fixtures.taskIds);
    memberAssignedProjectId = fixtures.assignedProjectId;
    memberUnassignedProjectId = fixtures.unassignedProjectId;
    temporaryIds.milestone.push(fixtures.milestoneId);
    temporaryIds.feedback.push(...fixtures.feedbackIds);
    temporaryIds.activity.push(fixtures.activityId);
    temporaryIds.meeting.push(fixtures.meetingId);
    temporaryIds.file.push(fixtures.fileId);
  }, 30000);

  beforeEach(() => {
    providerGenerate.mockReset();
    providerGenerate.mockResolvedValue(validReport);
  });

  afterAll(async () => {
    try {
      for (const auth of sessions) {
        await fetch(`${baseUrl}/api/v1/auth/logout`, { method: "POST", headers: { Cookie: auth.cookie, "X-CSRF-Token": auth.csrfToken } }).catch(() => undefined);
      }
      await prisma.$transaction(async (tx) => {
        await tx.file.deleteMany({ where: { id: { in: temporaryIds.file } } });
        await tx.meeting.deleteMany({ where: { id: { in: temporaryIds.meeting } } });
        await tx.feedback.deleteMany({ where: { id: { in: temporaryIds.feedback } } });
        await tx.activityLog.deleteMany({ where: { id: { in: temporaryIds.activity } } });
        await tx.task.deleteMany({ where: { id: { in: temporaryIds.task } } });
        await tx.milestone.deleteMany({ where: { id: { in: temporaryIds.milestone } } });
        await tx.project.deleteMany({ where: { id: { in: temporaryIds.project } } });
        await tx.authSession.deleteMany({ where: { userId: { in: temporaryIds.user } } });
        await tx.agencyMember.deleteMany({ where: { userId: { in: temporaryIds.user } } });
        await tx.user.deleteMany({ where: { id: { in: temporaryIds.user } } });
      });
    } finally {
      if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 30000);

  it("allows Northstar's owner and supplies only Northstar data with backend metrics", async () => {
    const auth = await login("owner@northstar.test");
    const before = await projectState("agency_northstar", "project_northstar");
    const response = await report(auth, "project_northstar");
    expect(response.status).toBe(200);
    const body = await response.json() as { advisory: boolean; generatedAt: string; metrics: Record<string, number>; report: unknown };
    expect(body.advisory).toBe(true);
    expect(Number.isNaN(Date.parse(body.generatedAt))).toBe(false);
    expect(body.metrics).toMatchObject({ taskCompletionPercent: 25, totalTasks: 4, completedTasks: 1, overdueTasks: 1, openFeedback: 1, upcomingMilestones: 1 });
    expect(body.report).toEqual(validReport);
    expect(providerGenerate).toHaveBeenCalledTimes(1);
    const providerPrompt = providerGenerate.mock.calls[0]?.[0];
    expect(providerPrompt).toBeTypeOf("string");
    const payload = JSON.parse(providerPrompt ?? "") as { project: { name: string }; tasks: Array<{ title: string }>; feedback: Array<{ title: string }>; recentActivity: Array<{ eventType: string }> };
    expect(payload.project.name).toContain("Northstar");
    expect(JSON.stringify(payload)).not.toContain("Lighthouse");
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_MEETING_NOTES_SENTINEL");
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_FILE_METADATA_SENTINEL");
    expect(payload.tasks.map((task) => task.title)).toContain("phase9-test-overdue-task");
    expect(payload.feedback.map((item) => item.title)).toContain("phase9-test-open-feedback");
    expect(payload.recentActivity.map((item) => item.eventType)).toContain("phase9_test_recent_activity");
    expect(await projectState("agency_northstar", "project_northstar")).toEqual(before);
  });

  it("rejects Northstar to Lighthouse cross-tenant access before provider invocation", async () => {
    const auth = await login("owner@northstar.test");
    providerGenerate.mockClear();
    const response = await report(auth, "project_lighthouse");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(providerGenerate).not.toHaveBeenCalled();
  });

  it("allows Lighthouse's owner to obtain a Lighthouse-only report", async () => {
    const auth = await login("owner@lighthouse.test");
    const response = await report(auth, "project_lighthouse");
    expect(response.status).toBe(200);
    const body = await response.json() as { metrics: Record<string, number>; advisory: boolean };
    expect(body.advisory).toBe(true);
    expect(body.metrics).toMatchObject({ taskCompletionPercent: 0, totalTasks: 1, completedTasks: 0, overdueTasks: 0, openFeedback: 0, upcomingMilestones: 0 });
    const providerPrompt = providerGenerate.mock.calls[0]?.[0];
    expect(providerPrompt).toBeTypeOf("string");
    const payload = JSON.parse(providerPrompt ?? "") as { project: { name: string } };
    expect(payload.project.name).toContain("Lighthouse");
    expect(JSON.stringify(payload)).not.toContain("Northstar");
  });

  it("rejects Lighthouse to Northstar cross-tenant access before provider invocation", async () => {
    const auth = await login("owner@lighthouse.test");
    providerGenerate.mockClear();
    const response = await report(auth, "project_northstar");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(providerGenerate).not.toHaveBeenCalled();
  });

  it("rejects nonexistent projects without invoking the provider", async () => {
    const auth = await login("owner@northstar.test");
    providerGenerate.mockClear();
    const response = await report(auth, "project_does_not_exist");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(providerGenerate).not.toHaveBeenCalled();
  });

  it("limits MEMBER reports to projects with an assigned task and assigned task data", async () => {
    const auth = await login(memberEmail);
    const response = await report(auth, memberAssignedProjectId);
    expect(response.status).toBe(200);
    const body = await response.json() as { metrics: Record<string, number> };
    expect(body.metrics).toMatchObject({ taskCompletionPercent: 0, totalTasks: 1, completedTasks: 0 });
    const providerPrompt = providerGenerate.mock.calls[0]?.[0];
    const payload = JSON.parse(providerPrompt ?? "") as { tasks: Array<{ title: string }> };
    expect(payload.tasks.map((task) => task.title)).toEqual(["phase9-test-member-assigned-task"]);

    providerGenerate.mockClear();
    const unassigned = await report(auth, memberUnassignedProjectId);
    expect(unassigned.status).toBe(404);
    expect(await unassigned.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(providerGenerate).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated, client-role, and missing-CSRF requests before provider invocation", async () => {
    const token = await csrf();
    const anonymous = await report({ cookie: token.cookie, csrfToken: token.token }, "project_northstar");
    expect(anonymous.status).toBe(401);
    const client = await login("client@northstar.test");
    const clientResponse = await report(client, "project_northstar");
    expect(clientResponse.status).toBe(403);
    const agency = await login("owner@northstar.test");
    const csrfResponse = await report(agency, "project_northstar", { csrfToken: "", cookie: agency.cookie });
    expect(csrfResponse.status).toBe(403);
    expect(providerGenerate).not.toHaveBeenCalled();
  });

  it("returns a safe provider failure and leaves project/task state unchanged", async () => {
    const auth = await login("owner@northstar.test");
    const before = await projectState("agency_northstar", "project_northstar");
    providerGenerate.mockRejectedValueOnce(new AiProviderError("provider"));
    const response = await report(auth, "project_northstar");
    expect(response.status).toBe(502);
    const body = await response.json() as { error: { code: string; message: string }; advisory: boolean; aiAvailable: boolean; metrics: Record<string, number> };
    expect(body.error).toEqual({ code: "AI_UNAVAILABLE", message: "The AI provider could not produce a valid report. Try again." });
    expect(body.advisory).toBe(true);
    expect(body.aiAvailable).toBe(false);
    expect(body.metrics).toMatchObject({ totalTasks: 4, completedTasks: 1, overdueTasks: 1, taskCompletionPercent: 25 });
    expect(JSON.stringify(body)).not.toContain("PRIVATE_MEETING_NOTES_SENTINEL");
    expect(await projectState("agency_northstar", "project_northstar")).toEqual(before);
  });

  it("normalizes an upstream quota rejection to HTTP 429 while keeping backend metrics authoritative", async () => {
    const auth = await login("owner@northstar.test");
    const before = await projectState("agency_northstar", "project_northstar");
    providerGenerate.mockRejectedValueOnce(new AiProviderError("provider", 429));
    const response = await report(auth, "project_northstar");
    expect(response.status).toBe(429);
    const body = await response.json() as { error: { code: string; message: string }; advisory: boolean; aiAvailable: boolean; metrics: Record<string, number> };
    expect(body.error.code).toBe("AI_PROVIDER_QUOTA_EXCEEDED");
    expect(body.error.message).toBe("The AI provider could not produce a valid report. Try again.");
    expect(body.advisory).toBe(true);
    expect(body.aiAvailable).toBe(false);
    expect(body.metrics).toMatchObject({ totalTasks: 4, completedTasks: 1, overdueTasks: 1, taskCompletionPercent: 25 });
    expect(await projectState("agency_northstar", "project_northstar")).toEqual(before);
  });

  it("normalizes an upstream capacity rejection to HTTP 503 with backend metrics", async () => {
    const auth = await login("owner@lighthouse.test");
    providerGenerate.mockRejectedValueOnce(new AiProviderError("provider", 503));
    const response = await report(auth, "project_lighthouse");
    expect(response.status).toBe(503);
    const body = await response.json() as { error: { code: string }; metrics: Record<string, number> };
    expect(body.error.code).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(body.metrics).toMatchObject({ totalTasks: 1, completedTasks: 0, taskCompletionPercent: 0 });
  });
});