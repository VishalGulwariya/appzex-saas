import { Router } from "express";
import { AgencyStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { authenticate, requireSuperAdmin } from "../auth/auth.middleware.js";

export const adminRouter = Router();
adminRouter.use(authenticate, requireSuperAdmin);

const pageQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20)
});
const createAgencySchema = z.object({
  name: z.string().trim().min(2).max(160),
  slug: z.string().trim().toLowerCase().min(2).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and single hyphens")
}).strict();
const statusSchema = z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) }).strict();
const supportSchema = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
async function logActivity(actorId: string, eventType: string, entityType: string, entityId: string, summary: string, agencyId?: string) {
  await prisma.platformActivity.create({ data: { actorId, eventType, entityType, entityId, summary, agencyId: agencyId ?? null } });
}

adminRouter.get("/dashboard", async (_request, response) => {
  const [totalAgencies, activeAgencies, suspendedAgencies, users, clients, projects, activeSupportSessions, recentActivity] = await Promise.all([
    prisma.agency.count(),
    prisma.agency.count({ where: { status: AgencyStatus.ACTIVE } }),
    prisma.agency.count({ where: { status: AgencyStatus.SUSPENDED } }),
    prisma.user.count(),
    prisma.client.count(),
    prisma.project.count(),
    prisma.supportSession.count({ where: { endedAt: null } }),
    prisma.platformActivity.findMany({ take: 8, orderBy: [{ createdAt: "desc" }, { id: "asc" }], include: { actor: { select: { name: true } }, agency: { select: { name: true } } } })
  ]);
  response.json({ metrics: { totalAgencies, activeAgencies, suspendedAgencies, users, clients, projects, activeSupportSessions }, recentActivity });
});

adminRouter.get("/agencies", async (request, response) => {
  const parsed = pageQuery.safeParse(request.query);
  if (!parsed.success) { response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid agency filters or pagination" } }); return; }
  const { q, status, page, pageSize } = parsed.data;
  const where = {
    ...(status ? { status: status as AgencyStatus } : {}),
    ...(q ? { OR: [{ name: { contains: q } }, { slug: { contains: q } }] } : {})
  };
  const [items, total] = await Promise.all([
    prisma.agency.findMany({ where, skip: (page - 1) * pageSize, take: pageSize, orderBy: [{ createdAt: "desc" }, { id: "asc" }], include: { _count: { select: { members: true, clients: true, projects: true } } } }),
    prisma.agency.count({ where })
  ]);
  response.json({ items, page, pageSize, total, pageCount: Math.ceil(total / pageSize) });
});

adminRouter.post("/agencies", async (request, response) => {
  const parsed = createAgencySchema.safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Provide a valid agency name and URL slug" } }); return; }
  try {
    const agency = await prisma.$transaction(async (transaction) => {
      const created = await transaction.agency.create({ data: parsed.data });
      await transaction.agencySettings.create({ data: { agencyId: created.id } });
      await transaction.platformActivity.create({ data: { actorId: request.auth!.userId, agencyId: created.id, eventType: "agency.created", entityType: "agency", entityId: created.id, summary: `Created agency ${created.name}` } });
      return created;
    });
    response.status(201).json({ agency });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      response.status(409).json({ error: { code: "SLUG_TAKEN", message: "That agency slug is already in use" } }); return;
    }
    throw error;
  }
});

adminRouter.get("/agencies/:id", async (request, response) => {
  const agency = await prisma.agency.findUnique({ where: { id: request.params.id }, include: {
    _count: { select: { members: true, clients: true, projects: true } },
    supportSessions: { take: 8, orderBy: { startedAt: "desc" }, include: { superAdmin: { select: { name: true, email: true } } } },
    platformActivity: { take: 10, orderBy: { createdAt: "desc" }, include: { actor: { select: { name: true } } } }
  } });
  if (!agency) { response.status(404).json({ error: { code: "NOT_FOUND", message: "Agency not found" } }); return; }
  response.json({ agency });
});

adminRouter.patch("/agencies/:id/status", async (request, response) => {
  const parsed = statusSchema.safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Choose ACTIVE or SUSPENDED" } }); return; }
  const existing = await prisma.agency.findUnique({ where: { id: request.params.id }, select: { id: true, name: true, status: true } });
  if (!existing) { response.status(404).json({ error: { code: "NOT_FOUND", message: "Agency not found" } }); return; }
  const agency = await prisma.agency.update({ where: { id: existing.id }, data: { status: parsed.data.status } });
  if (existing.status !== agency.status) await logActivity(request.auth!.userId, `agency.${agency.status.toLowerCase()}`, "agency", agency.id, `${agency.status === "SUSPENDED" ? "Suspended" : "Reactivated"} agency ${agency.name}`, agency.id);
  response.json({ agency });
});

adminRouter.post("/agencies/:id/support-sessions", async (request, response) => {
  const context = request.auth!;
  const parsed = supportSchema.safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "A reason of 10 to 500 characters is required" } }); return; }
  if (context.supportSessionId) { response.status(409).json({ error: { code: "SUPPORT_SESSION_ACTIVE", message: "End the current support session before entering another agency" } }); return; }
  const agency = await prisma.agency.findUnique({ where: { id: request.params.id }, select: { id: true, name: true } });
  if (!agency) { response.status(404).json({ error: { code: "NOT_FOUND", message: "Agency not found" } }); return; }
  const open = await prisma.supportSession.findFirst({ where: { superAdminId: context.userId, endedAt: null } });
  if (open) {
    const linked = await prisma.authSession.findFirst({ where: { userId: context.userId, activeSupportSessionId: open.id, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } });
    if (linked) { response.status(409).json({ error: { code: "SUPPORT_SESSION_ACTIVE", message: "End the existing support session before entering another agency" } }); return; }
    await prisma.$transaction(async (tx) => {
      await tx.supportSession.update({ where: { id: open.id }, data: { endedAt: new Date() } });
      await tx.authSession.updateMany({ where: { activeSupportSessionId: open.id }, data: { activeSupportSessionId: null } });
    });
  }
  const support = await prisma.$transaction(async (tx) => {
    const created = await tx.supportSession.create({ data: { superAdminId: context.userId, agencyId: agency.id, reason: parsed.data.reason } });
    await tx.authSession.update({ where: { id: context.sessionId }, data: { activeSupportSessionId: created.id } });
    await tx.platformActivity.create({ data: { actorId: context.userId, agencyId: agency.id, eventType: "support.started", entityType: "support_session", entityId: created.id, summary: `Started support session for ${agency.name}`, metadata: { reason: created.reason } } });
    return created;
  });
  response.status(201).json({ supportSession: { id: support.id, agency, reason: support.reason, startedAt: support.startedAt } });
});

adminRouter.delete("/support-sessions/:id", async (request, response) => {
  const context = request.auth!;
  const support = await prisma.supportSession.findFirst({ where: { id: request.params.id, superAdminId: context.userId, endedAt: null }, include: { agency: { select: { id: true, name: true } } } });
  if (!support) { response.status(404).json({ error: { code: "NOT_FOUND", message: "Active support session not found" } }); return; }
  const endedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.supportSession.update({ where: { id: support.id }, data: { endedAt } });
    await tx.authSession.updateMany({ where: { userId: context.userId, activeSupportSessionId: support.id }, data: { activeSupportSessionId: null } });
    await tx.platformActivity.create({ data: { actorId: context.userId, agencyId: support.agencyId, eventType: "support.ended", entityType: "support_session", entityId: support.id, summary: `Ended support session for ${support.agency.name}`, metadata: { reason: support.reason } } });
  });
  response.json({ supportMode: false, endedAt });
});

adminRouter.get("/activity", async (request, response) => {
  const parsed = pageQuery.pick({ page: true, pageSize: true }).safeParse(request.query);
  if (!parsed.success) { response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Invalid pagination" } }); return; }
  const { page, pageSize } = parsed.data;
  const [items, total] = await Promise.all([
    prisma.platformActivity.findMany({ skip: (page - 1) * pageSize, take: pageSize, orderBy: [{ createdAt: "desc" }, { id: "asc" }], include: { actor: { select: { id: true, name: true, email: true } }, agency: { select: { id: true, name: true } } } }),
    prisma.platformActivity.count()
  ]);
  response.json({ items, page, pageSize, total, pageCount: Math.ceil(total / pageSize) });
});

export async function recordSupportAction(input: { actorId: string; agencyId: string; supportSessionId: string; eventType: string; entityType: string; entityId: string; summary: string }) {
  await prisma.platformActivity.create({ data: {
    actorId: input.actorId, agencyId: input.agencyId, eventType: `support.${input.eventType}`,
    entityType: input.entityType, entityId: input.entityId, summary: input.summary,
    metadata: { supportSessionId: input.supportSessionId }
  } });
}







