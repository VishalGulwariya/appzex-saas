import { ActivityVisibility, AgencyRole, FeedbackStatus } from "@prisma/client";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { authenticate, requireAgencyContext } from "../auth/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";
import { canPerform } from "../../policies/authorization.js";
import { findProjectForContext, listProjectsForContext } from "../../repositories/projects.repository.js";
import { tenantScope } from "../../repositories/tenant-scope.js";

export const communicationsRouter = Router();
communicationsRouter.use(authenticate);
async function requireWorkspace(request: Request, response: Response, next: NextFunction): Promise<void> {
  if (request.auth?.portal === "agency") { requireAgencyContext(request, response, next); return; }
  if (request.auth?.portal === "super-admin" && request.auth.supportSessionId && request.auth.supportAgencyId) { next(); return; }
  response.status(request.auth?.portal === "selection" ? 409 : 403).json({ error: { code: "AGENCY_CONTEXT_REQUIRED", message: "An agency workspace or explicit support session is required" } });
}
communicationsRouter.use(requireWorkspace);
const meetingSchema = z.object({ projectId: z.string().min(1).max(30), title: z.string().trim().min(2).max(180), scheduledAt: z.string().datetime(), notes: z.string().trim().max(5000).optional(), clientVisible: z.boolean().default(false) }).strict();
const commentSchema = z.object({ body: z.string().trim().min(1).max(5000) }).strict();
const feedbackStatusSchema = z.object({ status: z.nativeEnum(FeedbackStatus) }).strict();
const fail = (response: Response, status: number, code: string, message: string) => response.status(status).json({ error: { code, message } });
const isAdmin = (request: Request) => request.auth?.portal === "super-admin" || request.auth?.agencyRole === AgencyRole.OWNER || request.auth?.agencyRole === AgencyRole.ADMIN;

communicationsRouter.get("/meetings", async (request, response) => {
  const scope = tenantScope(request.auth!);
  const projects = await listProjectsForContext(request.auth!, { take: 200 });
  const projectIds = projects.map((project) => project.id);
  const items = projectIds.length ? await prisma.meeting.findMany({ where: { agencyId: scope.agencyId, projectId: { in: projectIds } }, orderBy: { scheduledAt: "asc" }, take: 100, include: { project: { select: { id: true, name: true } } } }) : [];
  response.json({ items });
});
communicationsRouter.post("/meetings", async (request, response) => {
  const parsed = meetingSchema.safeParse(request.body); if (!parsed.success) { fail(response, 400, "VALIDATION_ERROR", "Provide a project, title, and valid meeting time"); return; }
  const project = await findProjectForContext(request.auth!, parsed.data.projectId); if (!project) { fail(response, 404, "NOT_FOUND", "Project not found"); return; }
  if (parsed.data.clientVisible && !isAdmin(request) && project.managerId !== request.auth!.userId) { fail(response, 403, "FORBIDDEN", "Only an agency admin or project manager can share meeting notes with a client"); return; }
  const meeting = await prisma.$transaction(async (tx) => {
    const created = await tx.meeting.create({ data: { agencyId: project.agencyId, projectId: project.id, title: parsed.data.title, scheduledAt: new Date(parsed.data.scheduledAt), ...(parsed.data.notes ? { notes: parsed.data.notes } : {}), clientVisible: parsed.data.clientVisible } });
    await tx.activityLog.create({ data: { agencyId: project.agencyId, actorId: request.auth!.portal === "agency" ? request.auth!.userId : null, eventType: "meeting.created", entityType: "project", entityId: project.id, visibility: parsed.data.clientVisible ? ActivityVisibility.CLIENT_VISIBLE : ActivityVisibility.INTERNAL } });
    return created;
  }); response.status(201).json({ meeting: { id: meeting.id, title: meeting.title, scheduledAt: meeting.scheduledAt, notes: meeting.notes, clientVisible: meeting.clientVisible, projectId: meeting.projectId } });
});

communicationsRouter.get("/feedback", async (request, response) => {
  const scope = tenantScope(request.auth!); const projects = await listProjectsForContext(request.auth!, { take: 200 }); const ids = projects.map((project) => project.id);
  const items = ids.length ? await prisma.feedback.findMany({ where: { agencyId: scope.agencyId, projectId: { in: ids } }, orderBy: { updatedAt: "desc" }, take: 100, include: { project: { select: { id: true, name: true, client: { select: { companyName: true } } } }, submitter: { select: { name: true, email: true } }, comments: { orderBy: { createdAt: "asc" }, include: { author: { select: { name: true } } } } } }) : [];
  response.json({ items });
});
communicationsRouter.post("/feedback/:id/comments", async (request, response) => {
  const parsed = commentSchema.safeParse(request.body); if (!parsed.success) { fail(response, 400, "VALIDATION_ERROR", "A comment is required"); return; }
  const scope = tenantScope(request.auth!);
  const feedback = await prisma.feedback.findFirst({ where: { id: request.params.id, agencyId: scope.agencyId }, select: { id: true, projectId: true } });
  if (!feedback || !await findProjectForContext(request.auth!, feedback.projectId)) { fail(response, 404, "NOT_FOUND", "Feedback not found"); return; }
  const [comment, member] = await Promise.all([
    prisma.feedbackComment.create({ data: { agencyId: scope.agencyId, feedbackId: feedback.id, authorId: request.auth!.userId, body: parsed.data.body } }),
    prisma.agencyMember.findFirst({ where: { agencyId: scope.agencyId, userId: request.auth!.userId }, select: { user: { select: { name: true } } } })
  ]);
  await prisma.activityLog.create({ data: { agencyId: scope.agencyId, actorId: request.auth!.portal === "agency" ? request.auth!.userId : null, eventType: "feedback.comment_added", entityType: "project", entityId: feedback.projectId, visibility: ActivityVisibility.CLIENT_VISIBLE } });
  response.status(201).json({ comment: { id: comment.id, body: comment.body, createdAt: comment.createdAt, author: { name: member?.user.name ?? "Support" } } });
});
communicationsRouter.patch("/feedback/:id/status", async (request, response) => {
  const parsed = feedbackStatusSchema.safeParse(request.body); if (!parsed.success) { fail(response, 400, "VALIDATION_ERROR", "Choose a valid feedback status"); return; }
  const scope = tenantScope(request.auth!);
  const feedback = await prisma.feedback.findFirst({ where: { id: request.params.id, agencyId: scope.agencyId }, select: { id: true, projectId: true } });
  if (!feedback || !await findProjectForContext(request.auth!, feedback.projectId)) { fail(response, 404, "NOT_FOUND", "Feedback not found"); return; }
  const project = await prisma.project.findFirst({ where: { id: feedback.projectId, agencyId: scope.agencyId }, select: { managerId: true } });
  if (!isAdmin(request) && project?.managerId !== request.auth!.userId) { fail(response, 403, "FORBIDDEN", "Only an agency admin or project manager can change feedback status"); return; }
  const updated = await prisma.feedback.update({ where: { id: feedback.id }, data: { status: parsed.data.status } });
  await prisma.activityLog.create({ data: { agencyId: scope.agencyId, actorId: request.auth!.portal === "agency" ? request.auth!.userId : null, eventType: "feedback.status_changed", entityType: "project", entityId: feedback.projectId, visibility: ActivityVisibility.CLIENT_VISIBLE } });
  response.json({ feedback: { id: updated.id, status: updated.status, updatedAt: updated.updatedAt } });
});

