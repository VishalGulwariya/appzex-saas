import { AgencyRole, FeedbackStatus, ProjectStatus, TaskStatus } from "@prisma/client";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { authenticate, requireAgencyContext } from "../auth/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";
import { canPerform } from "../../policies/authorization.js";
import { findProjectForContext, listProjectsForContext } from "../../repositories/projects.repository.js";
import { deriveProjectProgress, deriveProjectProgressFromCounts } from "../../repositories/project-progress.js";
import { findTaskForContext, listTasksForContext } from "../../repositories/tasks.repository.js";
import { tenantScope } from "../../repositories/tenant-scope.js";
import { createAiRateLimiter, RATE_LIMIT_MESSAGE } from "../../middleware/ai-rate-limiter.js";
import { env } from "../../config/env.js";
import { generateHealthReport, calculateHealthMetrics, AiProviderError, healthReportRequestSchema } from "../ai/project-health.js";

// Upstream capacity and quota failures are normalized to the same HTTP codes the client expects.
// Provider details are never echoed to the browser; only the backend-calculated metrics travel with them.
function providerCapacityStatus(upstreamStatus: number | undefined): number {
  if (upstreamStatus === 429) return 429;
  if (upstreamStatus === 503) return 503;
  return 502;
}
function providerCapacityCode(upstreamStatus: number | undefined): string {
  if (upstreamStatus === 429) return "AI_PROVIDER_QUOTA_EXCEEDED";
  if (upstreamStatus === 503) return "AI_PROVIDER_UNAVAILABLE";
  return "AI_UNAVAILABLE";
}

export const agencyRouter = Router();
const healthReportRateLimiter = createAiRateLimiter({ limit: env.AI_REPORT_RATE_LIMIT });
agencyRouter.use(authenticate);
async function requireAgencyPortal(request: Request, response: Response, next: NextFunction): Promise<void> {
  if (request.auth?.portal === "agency") { requireAgencyContext(request, response, next); return; }
  if (request.auth?.portal === "super-admin" && request.auth.supportSessionId && request.auth.supportAgencyId) {
    await prisma.platformActivity.create({ data: {
      actorId: request.auth.userId,
      agencyId: request.auth.supportAgencyId,
      eventType: `support.agency.${request.method.toLowerCase()}`,
      entityType: "agency_workspace_access",
      entityId: request.auth.supportAgencyId,
      summary: `Support mode ${request.method} ${request.path}`.slice(0, 500),
      metadata: { supportSessionId: request.auth.supportSessionId, method: request.method, path: request.path }
    } });
    next(); return;
  }
  response.status(request.auth?.portal === "selection" ? 409 : 403).json({ error: { code: "AGENCY_CONTEXT_REQUIRED", message: "An active agency workspace or explicit support session is required" } });
}
agencyRouter.use(requireAgencyPortal);

const clientSchema = z.object({ companyName: z.string().trim().min(2).max(180), contactName: z.string().trim().max(160).optional(), email: z.string().trim().email().max(254).optional(), phone: z.string().trim().max(40).optional(), notes: z.string().trim().max(3000).optional() }).strict();
const projectSchema = z.object({ clientId: z.string().min(1).max(30), managerId: z.string().min(1).max(30).optional(), name: z.string().trim().min(2).max(180), description: z.string().trim().max(5000).optional(), status: z.nativeEnum(ProjectStatus).optional(), priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(), startDate: z.string().date().optional(), dueDate: z.string().date().optional() }).strict();
const taskSchema = z.object({ title: z.string().trim().min(2).max(180), description: z.string().trim().max(3000).optional(), priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(), dueDate: z.string().date().optional(), assigneeId: z.string().min(1).max(30).optional() }).strict();
const taskUpdateSchema = z.object({ status: z.nativeEnum(TaskStatus) }).strict();
const memberSchema = z.object({ email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()), role: z.nativeEnum(AgencyRole).refine((role) => role !== AgencyRole.OWNER) }).strict();
const validationError = (response: Response, message: string) => response.status(400).json({ error: { code: "VALIDATION_ERROR", message } });
const permissionError = (response: Response) => response.status(403).json({ error: { code: "FORBIDDEN", message: "Your workspace role cannot perform this action" } });
type ScopedHealthProject = NonNullable<Awaited<ReturnType<typeof findProjectForContext>>>;
const authorizedHealthProjects = new WeakMap<Request, ScopedHealthProject>();

async function authorizeHealthReportProject(request: Request, response: Response, next: NextFunction): Promise<void> {
  if (!healthReportRequestSchema.safeParse(request.body).success) { validationError(response, "Health report requests must have an empty JSON body"); return; }
  const projectId = request.params.id;
  if (typeof projectId !== "string") { response.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found" } }); return; }
  const scoped = await findProjectForContext(request.auth!, projectId);
  if (!scoped) { response.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found" } }); return; }
  authorizedHealthProjects.set(request, scoped);
  next();
}

agencyRouter.get("/dashboard", async (request, response) => {
  const { agencyId } = tenantScope(request.auth!); const now = new Date(); const until = new Date(now.getTime() + 14 * 86400000);
  const [scopedProjects, scopedTasks] = await Promise.all([listProjectsForContext(request.auth!, { take: 200 }), listTasksForContext(request.auth!)]);
  const scopedProjectIds = scopedProjects.map((project) => project.id);
  const dueTasks = scopedTasks.filter((task) => task.dueDate && task.dueDate >= now && task.dueDate <= until && task.status !== TaskStatus.DONE).slice(0, 8);
  const [clients, activeProjects, completedProjects, pendingFeedback, projects, dueProjects] = await Promise.all([
    prisma.client.count({ where: { agencyId } }),
    request.auth!.agencyRole === AgencyRole.OWNER || request.auth!.agencyRole === AgencyRole.ADMIN ? prisma.project.count({ where: { agencyId, status: ProjectStatus.ACTIVE } }) : Promise.resolve(scopedProjects.filter((project) => project.status === ProjectStatus.ACTIVE).length),
    request.auth!.agencyRole === AgencyRole.OWNER || request.auth!.agencyRole === AgencyRole.ADMIN ? prisma.project.count({ where: { agencyId, status: ProjectStatus.COMPLETED } }) : Promise.resolve(scopedProjects.filter((project) => project.status === ProjectStatus.COMPLETED).length),
    prisma.feedback.count({ where: { agencyId, status: { in: [FeedbackStatus.OPEN, FeedbackStatus.IN_PROGRESS] } } }),
    prisma.project.findMany({ where: { agencyId, id: { in: scopedProjectIds } }, orderBy: { updatedAt: "desc" }, take: 8, include: { client: { select: { companyName: true } }, tasks: { select: { status: true } } } }),
    prisma.project.findMany({ where: { agencyId, id: { in: scopedProjectIds }, dueDate: { gte: now, lte: until }, status: { notIn: [ProjectStatus.COMPLETED, ProjectStatus.ARCHIVED] } }, orderBy: { dueDate: "asc" }, take: 8, select: { id: true, name: true, dueDate: true } })
  ]);
  response.json({ metrics: { clients, activeProjects, completedProjects, pendingFeedback }, projects: projects.map(({ tasks, ...project }) => ({ ...project, progress: deriveProjectProgress(tasks) })), upcomingDeadlines: [
    ...dueProjects.map((item) => ({ ...item, type: "project" as const })),
    ...dueTasks.map((item) => ({ id: item.id, name: item.title, dueDate: item.dueDate, projectId: item.project.id, projectName: item.project.name, type: "task" as const }))
  ].sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime()).slice(0, 8) });
});

agencyRouter.get("/clients", async (request, response) => {
  const { agencyId } = tenantScope(request.auth!); const q = typeof request.query.q === "string" ? request.query.q.trim().slice(0, 100) : "";
  const items = await prisma.client.findMany({ where: { agencyId, ...(q ? { companyName: { contains: q } } : {}) }, orderBy: [{ companyName: "asc" }, { id: "asc" }], take: 100, include: { _count: { select: { projects: true, members: true } } } }); response.json({ items });
});
agencyRouter.post("/clients", async (request, response) => {
  const parsed = clientSchema.safeParse(request.body); if (!parsed.success) { validationError(response, "Provide valid client details"); return; }
  const { agencyId } = tenantScope(request.auth!);
  if (!canPerform("clients:create", request.auth!, { agencyId })) { permissionError(response); return; }
  const client = await prisma.$transaction(async (tx) => { const created = await tx.client.create({ data: { agencyId, companyName: parsed.data.companyName, contactName: parsed.data.contactName ?? null, email: parsed.data.email ?? null, phone: parsed.data.phone ?? null, notes: parsed.data.notes ?? null } }); await tx.activityLog.create({ data: { agencyId, actorId: request.auth!.portal === "agency" ? request.auth!.userId : null, eventType: "client.created", entityType: "client", entityId: created.id } }); return created; });
  response.status(201).json({ client });
});

agencyRouter.get("/projects", async (request, response) => {
  const status = typeof request.query.status === "string" && Object.values(ProjectStatus).includes(request.query.status as ProjectStatus) ? request.query.status as ProjectStatus : undefined;
  const clientId = typeof request.query.clientId === "string" ? request.query.clientId : undefined;
  const search = typeof request.query.q === "string" ? request.query.q.slice(0, 100) : undefined;
  const projects = await listProjectsForContext(request.auth!, { ...(status ? { status } : {}), ...(clientId ? { clientId } : {}), ...(search ? { search } : {}), take: 100 });
  const items = await Promise.all(projects.map(async (project) => {
    const [counts, client] = await Promise.all([
      prisma.task.groupBy({ by: ["status"], where: { agencyId: project.agencyId, projectId: project.id }, _count: { _all: true } }),
      prisma.client.findFirst({ where: { id: project.clientId, agencyId: project.agencyId }, select: { companyName: true } })
    ]);
    const total = counts.reduce((sum, row) => sum + row._count._all, 0); const done = counts.find((row) => row.status === TaskStatus.DONE)?._count._all ?? 0;
    return { ...project, client: client ?? { companyName: "Client" }, progress: deriveProjectProgressFromCounts(total, done) };
  })); response.json({ items });
});
agencyRouter.post("/projects", async (request, response) => {
  const parsed = projectSchema.safeParse(request.body); if (!parsed.success) { validationError(response, "Provide a valid project name, client, and dates"); return; }
  const { agencyId } = tenantScope(request.auth!); if (!canPerform("projects:create", request.auth!, { agencyId })) { permissionError(response); return; }
  const client = await prisma.client.findFirst({ where: { id: parsed.data.clientId, agencyId }, select: { id: true } });
  if (!client) { response.status(400).json({ error: { code: "INVALID_CLIENT", message: "Choose a client in this agency" } }); return; }
  if (parsed.data.managerId && !await prisma.agencyMember.findFirst({ where: { agencyId, userId: parsed.data.managerId }, select: { userId: true } })) { response.status(400).json({ error: { code: "INVALID_MANAGER", message: "Choose a member of this agency" } }); return; }
  const project = await prisma.$transaction(async (tx) => {
    const created = await tx.project.create({ data: { agencyId, clientId: parsed.data.clientId, managerId: parsed.data.managerId ?? null, name: parsed.data.name, ...(parsed.data.description ? { description: parsed.data.description } : {}), ...(parsed.data.status ? { status: parsed.data.status } : {}), ...(parsed.data.priority ? { priority: parsed.data.priority } : {}), startDate: parsed.data.startDate ? new Date(`${parsed.data.startDate}T00:00:00.000Z`) : null, dueDate: parsed.data.dueDate ? new Date(`${parsed.data.dueDate}T00:00:00.000Z`) : null } });
    await tx.activityLog.create({ data: { agencyId, actorId: request.auth!.portal === "agency" ? request.auth!.userId : null, eventType: "project.created", entityType: "project", entityId: created.id } }); return created;
  }); response.status(201).json({ project });
});
agencyRouter.get("/projects/:id", async (request, response) => {
  const scoped = await findProjectForContext(request.auth!, request.params.id); if (!scoped) { response.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found" } }); return; }
  const [project, tasks, activity] = await Promise.all([
    prisma.project.findFirst({ where: { id: scoped.id, agencyId: scoped.agencyId }, include: { client: { select: { id: true, companyName: true } }, manager: { select: { user: { select: { id: true, name: true } } } }, milestones: { orderBy: [{ position: "asc" }, { dueDate: "asc" }] }, tasks: { orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }], include: { assignee: { select: { user: { select: { id: true, name: true } } } } } } } }),
    listTasksForContext(request.auth!, scoped.id, null),
    prisma.activityLog.findMany({ where: { agencyId: scoped.agencyId, entityType: "project", entityId: scoped.id }, orderBy: { createdAt: "desc" }, take: 30, include: { actor: { select: { user: { select: { name: true } } } } } })
  ]);
  if (!project) { response.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found" } }); return; }
  const visibleTasks = project.tasks.filter((task) => tasks.some((visible) => visible.id === task.id));
  response.json({ project: { ...project, tasks: visibleTasks, progress: deriveProjectProgress(visibleTasks) }, activity });
});

agencyRouter.post("/projects/:id/health-report", authorizeHealthReportProject, async (request, response) => {
  const scoped = authorizedHealthProjects.get(request);
  if (!scoped) { response.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found" } }); return; }
  const [tasks, milestones, feedback, activity] = await Promise.all([
    listTasksForContext(request.auth!, scoped.id, null),
    prisma.milestone.findMany({ where: { agencyId: scoped.agencyId, projectId: scoped.id }, orderBy: [{ dueDate: "asc" }, { position: "asc" }], select: { title: true, status: true, dueDate: true } }),
    prisma.feedback.findMany({ where: { agencyId: scoped.agencyId, projectId: scoped.id }, orderBy: { createdAt: "desc" }, select: { title: true, description: true, status: true, createdAt: true } }),
    prisma.activityLog.findMany({ where: { agencyId: scoped.agencyId, entityType: "project", entityId: scoped.id }, orderBy: { createdAt: "desc" }, take: 30, select: { eventType: true, createdAt: true } })
  ]);
  const context = { projectName: scoped.name, projectDescription: scoped.description, projectDueDate: scoped.dueDate, tasks: tasks.map(({ title, description, status, dueDate, priority }) => ({ title, description, status, dueDate, priority })), milestones, feedback, activity };
  // Backend-calculated metrics stay authoritative even when the upstream AI provider fails.
  const metrics = calculateHealthMetrics(context);
  // The AI report limit is applied after the metrics are known so a throttled request still
  // returns authoritative backend metrics instead of a bare error body.
  const verdict = healthReportRateLimiter.evaluate(request);
  if (!verdict.allowed) {
    response.setHeader("Retry-After", String(verdict.retryAfterSeconds));
    response.status(429).json({ advisory: true as const, aiAvailable: false, metrics, error: { code: "RATE_LIMIT_EXCEEDED", message: RATE_LIMIT_MESSAGE } });
    return;
  }
  try {
    const result = await generateHealthReport(context);
    response.json({ ...result, metrics: result.metrics ?? metrics });
  } catch (error) {
    if (error instanceof AiProviderError) {
      const status = error.kind === "not_configured" ? 503 : error.kind === "timeout" ? 504 : providerCapacityStatus(error.status);
      const code = error.kind === "not_configured" ? "AI_NOT_CONFIGURED" : error.kind === "timeout" ? "AI_TIMEOUT" : providerCapacityCode(error.status);
      const message = error.kind === "not_configured" ? "AI health reports are not configured." : error.kind === "timeout" ? "The AI provider timed out. Try again." : "The AI provider could not produce a valid report. Try again.";
      response.status(status).json({ advisory: true as const, aiAvailable: false, metrics, error: { code, message } }); return;
    }
    throw error;
  }
});
agencyRouter.post("/projects/:id/tasks", async (request, response) => {
  const parsed = taskSchema.safeParse(request.body); if (!parsed.success) { validationError(response, "Provide a valid task title and due date"); return; }
  const project = await findProjectForContext(request.auth!, request.params.id); if (!project) { response.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found" } }); return; }
  if (!canPerform("tasks:manage", request.auth!, { agencyId: project.agencyId, projectManagerId: project.managerId })) { permissionError(response); return; }
  if (parsed.data.assigneeId && !await prisma.agencyMember.findFirst({ where: { agencyId: project.agencyId, userId: parsed.data.assigneeId }, select: { userId: true } })) { response.status(400).json({ error: { code: "INVALID_ASSIGNEE", message: "Choose a member of this agency" } }); return; }
  const task = await prisma.$transaction(async (tx) => { const created = await tx.task.create({ data: { agencyId: project.agencyId, projectId: project.id, title: parsed.data.title, ...(parsed.data.description ? { description: parsed.data.description } : {}), ...(parsed.data.priority ? { priority: parsed.data.priority } : {}), assigneeId: parsed.data.assigneeId ?? null, dueDate: parsed.data.dueDate ? new Date(`${parsed.data.dueDate}T00:00:00.000Z`) : null } }); await tx.activityLog.create({ data: { agencyId: project.agencyId, actorId: request.auth!.portal === "agency" ? request.auth!.userId : null, eventType: "task.created", entityType: "project", entityId: project.id } }); return created; }); response.status(201).json({ task });
});
agencyRouter.get("/tasks", async (request, response) => { const projectId = typeof request.query.projectId === "string" ? request.query.projectId : undefined; response.json({ items: await listTasksForContext(request.auth!, projectId) }); });
agencyRouter.patch("/tasks/:id/status", async (request, response) => {
  const parsed = taskUpdateSchema.safeParse(request.body); if (!parsed.success) { validationError(response, "Choose a valid task status"); return; }
  const task = await findTaskForContext(request.auth!, request.params.id); if (!task) { response.status(404).json({ error: { code: "NOT_FOUND", message: "Task not found" } }); return; }
  if (!canPerform("tasks:manage", request.auth!, { agencyId: task.agencyId, taskAssigneeId: task.assigneeId, projectManagerId: task.project.managerId })) { permissionError(response); return; }
  const updated = await prisma.$transaction(async (tx) => { const saved = await tx.task.update({ where: { agencyId_id: { agencyId: task.agencyId, id: task.id } }, data: { status: parsed.data.status } }); await tx.activityLog.create({ data: { agencyId: task.agencyId, actorId: request.auth!.portal === "agency" ? request.auth!.userId : null, eventType: "task.status_changed", entityType: "project", entityId: task.projectId } }); return saved; }); response.json({ task: updated });
});

agencyRouter.get("/team", async (request, response) => { const { agencyId } = tenantScope(request.auth!); const items = await prisma.agencyMember.findMany({ where: { agencyId }, orderBy: [{ joinedAt: "asc" }, { id: "asc" }], include: { user: { select: { id: true, name: true, email: true } } } }); response.json({ items }); });
agencyRouter.post("/team", async (request, response) => {
  const parsed = memberSchema.safeParse(request.body); if (!parsed.success) { validationError(response, "Provide an existing user email and a permitted role"); return; }
  const { agencyId } = tenantScope(request.auth!);
  if (!canPerform("team:manage", request.auth!, { agencyId })) { permissionError(response); return; } const user = await prisma.user.findUnique({ where: { email: parsed.data.email }, select: { id: true } });
  if (!user) { response.status(404).json({ error: { code: "USER_NOT_FOUND", message: "That user must register before being added to a team" } }); return; }
  try {
    const member = await prisma.$transaction(async (tx) => { const created = await tx.agencyMember.create({ data: { agencyId, userId: user.id, role: parsed.data.role } }); await tx.activityLog.create({ data: { agencyId, actorId: request.auth!.portal === "agency" ? request.auth!.userId : null, eventType: "team.member_added", entityType: "agency_member", entityId: created.id } }); return created; }); response.status(201).json({ member });
  } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") { response.status(409).json({ error: { code: "ALREADY_MEMBER", message: "That user is already on this agency team" } }); return; } throw error; }
});













