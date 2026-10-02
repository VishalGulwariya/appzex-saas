import { ActivityVisibility, FeedbackStatus, FileVisibility, MilestoneStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { authenticate, requireClientContext } from "../auth/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";
import { clientTenantScope } from "../../repositories/tenant-scope.js";
import { deriveProjectProgress } from "../../repositories/project-progress.js";

export const clientRouter = Router();
clientRouter.use(authenticate, requireClientContext);
const feedbackSchema = z.object({ projectId: z.string().min(1).max(30), title: z.string().trim().min(4).max(180), description: z.string().trim().min(10).max(5000) }).strict();

async function visibleFiles(agencyId: string, clientId: string, projectIds?: string[]) {
  const rows = await prisma.file.findMany({
    where: {
      agencyId, visibility: FileVisibility.CLIENT_SHARED,
      ...(projectIds ? { OR: [{ projectId: { in: projectIds } }, { task: { project: { id: { in: projectIds } } } }, { feedback: { project: { id: { in: projectIds } } } }] } : {
        OR: [{ project: { clientId } }, { task: { project: { clientId } } }, { feedback: { project: { clientId } } }]
      })
    },
    orderBy: { createdAt: "desc" }, take: 100,
    include: { project: { select: { id: true, name: true } }, task: { select: { project: { select: { id: true, name: true } } } }, feedback: { select: { project: { select: { id: true, name: true } } } } }
  });
  return rows.map((file) => ({ id: file.id, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.sizeBytes.toString(), createdAt: file.createdAt, project: file.project ?? file.task?.project ?? file.feedback?.project ?? null }));
}

clientRouter.get("/dashboard", async (request, response) => {
  const { agencyId, clientId } = clientTenantScope(request.auth!);
  const now = new Date();
  const projects = await prisma.project.findMany({ where: { agencyId, clientId }, orderBy: { updatedAt: "desc" }, take: 100, include: { tasks: { select: { status: true } }, milestones: { where: { status: { not: MilestoneStatus.COMPLETED }, dueDate: { gte: now } }, orderBy: { dueDate: "asc" }, take: 5 } } });
  const projectIds = projects.map((project) => project.id);
  const [updates, feedback, files] = await Promise.all([
    projectIds.length ? prisma.activityLog.findMany({ where: { agencyId, entityType: "project", entityId: { in: projectIds }, visibility: ActivityVisibility.CLIENT_VISIBLE }, orderBy: { createdAt: "desc" }, take: 10, include: { actor: { select: { user: { select: { name: true } } } } } }) : Promise.resolve([]),
    prisma.feedback.count({ where: { agencyId, project: { clientId }, status: { in: [FeedbackStatus.OPEN, FeedbackStatus.IN_PROGRESS] } } }),
    visibleFiles(agencyId, clientId, projectIds)
  ]);
  const projectCards = projects.map(({ tasks, ...project }) => ({ id: project.id, name: project.name, status: project.status, priority: project.priority, dueDate: project.dueDate, updatedAt: project.updatedAt, progress: deriveProjectProgress(tasks), upcomingMilestone: project.milestones[0] ? { title: project.milestones[0].title, dueDate: project.milestones[0].dueDate, status: project.milestones[0].status } : null }));
  const deadlines = projects.flatMap((project) => [
    ...(project.dueDate && project.dueDate >= now ? [{ id: project.id, title: project.name, dueDate: project.dueDate, kind: "project" as const, projectId: project.id }] : []),
    ...project.milestones.map((milestone) => ({ id: milestone.id, title: milestone.title, dueDate: milestone.dueDate!, kind: "milestone" as const, projectId: project.id }))
  ]).sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()).slice(0, 8);
  response.json({ company: request.auth!.clientName, agency: request.auth!.agencyName, metrics: { projects: projects.length, pendingApprovals: feedback, sharedFiles: files.length }, projects: projectCards, upcomingDeadlines: deadlines, recentUpdates: updates.map((item) => ({ id: item.id, eventType: item.eventType, createdAt: item.createdAt, actor: item.actor ? { user: { name: item.actor.user.name } } : null })), sharedFiles: files.slice(0, 8) });
});

clientRouter.get("/projects", async (request, response) => {
  const { agencyId, clientId } = clientTenantScope(request.auth!);
  const projects = await prisma.project.findMany({ where: { agencyId, clientId }, orderBy: { updatedAt: "desc" }, take: 100, include: { tasks: { select: { status: true } } } });
  response.json({ items: projects.map(({ tasks, id, name, status, priority, dueDate, updatedAt }) => ({ id, name, status, priority, dueDate, updatedAt, progress: deriveProjectProgress(tasks) })) });
});

clientRouter.get("/projects/:id", async (request, response) => {
  const { agencyId, clientId } = clientTenantScope(request.auth!);
  const project = await prisma.project.findFirst({ where: { id: request.params.id, agencyId, clientId }, include: {
    client: { select: { companyName: true } },
    tasks: { select: { status: true } },
    milestones: { orderBy: [{ position: "asc" }, { dueDate: "asc" }] },
    meetings: { where: { clientVisible: true }, orderBy: { scheduledAt: "desc" }, take: 20, select: { id: true, title: true, scheduledAt: true, notes: true } },
    feedback: { orderBy: { createdAt: "desc" }, take: 30, include: { comments: { orderBy: { createdAt: "asc" }, include: { author: { select: { name: true } } } } } }
  } });
  if (!project) { response.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found" } }); return; }
  const [updates, files] = await Promise.all([
    prisma.activityLog.findMany({ where: { agencyId, entityType: "project", entityId: project.id, visibility: ActivityVisibility.CLIENT_VISIBLE }, orderBy: { createdAt: "desc" }, take: 30 }),
    visibleFiles(agencyId, clientId, [project.id])
  ]);
  const safeProject = { id: project.id, name: project.name, description: project.description, status: project.status, priority: project.priority, startDate: project.startDate, dueDate: project.dueDate, createdAt: project.createdAt, updatedAt: project.updatedAt, client: project.client };
  response.json({ project: { ...safeProject, milestones: project.milestones.map(({ id, title, status, dueDate }) => ({ id, title, status, dueDate })), meetings: project.meetings, feedback: project.feedback.map((item) => ({ id: item.id, title: item.title, description: item.description, status: item.status, createdAt: item.createdAt, project: { id: project.id, name: project.name }, comments: item.comments.map((comment) => ({ id: comment.id, body: comment.body, createdAt: comment.createdAt, author: comment.author })) })), progress: deriveProjectProgress(project.tasks) }, updates: updates.map((item) => ({ id: item.id, eventType: item.eventType, createdAt: item.createdAt })), sharedFiles: files });
});

clientRouter.get("/files", async (request, response) => {
  const { agencyId, clientId } = clientTenantScope(request.auth!);
  response.json({ items: await visibleFiles(agencyId, clientId) });
});

clientRouter.get("/feedback", async (request, response) => {
  const { agencyId, clientId } = clientTenantScope(request.auth!);
  const items = await prisma.feedback.findMany({ where: { agencyId, project: { clientId } }, orderBy: { updatedAt: "desc" }, take: 100, include: { project: { select: { id: true, name: true } }, comments: { orderBy: { createdAt: "asc" }, include: { author: { select: { name: true } } } } } });
  response.json({ items: items.map((item) => ({ id: item.id, title: item.title, description: item.description, status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt, project: item.project, comments: item.comments.map((comment) => ({ id: comment.id, body: comment.body, createdAt: comment.createdAt, author: comment.author })) })) });
});

clientRouter.post("/feedback", async (request, response) => {
  const parsed = feedbackSchema.safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "A project, title, and detailed request are required" } }); return; }
  const { agencyId, clientId } = clientTenantScope(request.auth!);
  const project = await prisma.project.findFirst({ where: { id: parsed.data.projectId, agencyId, clientId }, select: { id: true, name: true } });
  if (!project) { response.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found" } }); return; }
  const feedback = await prisma.$transaction(async (tx) => {
    const created = await tx.feedback.create({ data: { agencyId, projectId: project.id, submittedBy: request.auth!.userId, title: parsed.data.title, description: parsed.data.description } });
    await tx.activityLog.create({ data: { agencyId, actorId: null, eventType: "feedback.submitted", entityType: "project", entityId: project.id, visibility: ActivityVisibility.CLIENT_VISIBLE } });
    return created;
  });
  response.status(201).json({ feedback: { id: feedback.id, title: feedback.title, description: feedback.description, status: feedback.status, createdAt: feedback.createdAt, project: { id: project.id, name: project.name } } });
});






