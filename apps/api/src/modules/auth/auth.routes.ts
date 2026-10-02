import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { AgencyStatus, GlobalRole } from "@prisma/client";
import { compare, hash } from "bcryptjs";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { authenticate, createSessionToken, hashSessionToken, requireSuperAdmin } from "./auth.middleware.js";
import { clearCsrfCookie, clearSessionCookie, createCsrfToken, setCsrfCookie, setSessionCookie, SESSION_COOKIE } from "../../middleware/csrf.js";

const router = Router();
const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128)
}).strict();
const contextSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agency"), agencyId: z.string().min(1).max(30) }).strict(),
  z.object({ type: z.literal("client"), clientMembershipId: z.string().min(1).max(30) }).strict()
]);
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.AUTH_LOGIN_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMITED", message: "Too many sign-in attempts. Try again later." } }
});
const dummyHash = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

type AvailableContext =
  | { type: "agency"; agencyId: string; agencyName: string; role: string }
  | { type: "client"; agencyId: string; agencyName: string; clientId: string; clientName: string; clientMembershipId: string };

async function availableContexts(userId: string): Promise<AvailableContext[]> {
  const [agencyMemberships, clientMemberships] = await Promise.all([
    prisma.agencyMember.findMany({
      where: { userId, agency: { status: AgencyStatus.ACTIVE } },
      include: { agency: { select: { id: true, name: true } } }
    }),
    prisma.clientMember.findMany({
      where: { userId, agency: { status: AgencyStatus.ACTIVE } },
      include: { agency: { select: { id: true, name: true } }, client: { select: { id: true, companyName: true } } }
    })
  ]);
  return [
    ...agencyMemberships.map((membership) => ({
      type: "agency" as const, agencyId: membership.agencyId, agencyName: membership.agency.name, role: membership.role
    })),
    ...clientMemberships.map((membership) => ({
      type: "client" as const, agencyId: membership.agencyId, agencyName: membership.agency.name,
      clientId: membership.clientId, clientName: membership.client.companyName, clientMembershipId: membership.id
    }))
  ];
}

function contextRedirect(portal: "super-admin" | "agency" | "client" | "selection"): string {
  if (portal === "super-admin") return "/super-admin";
  if (portal === "agency") return "/agency";
  if (portal === "client") return "/client";
  return "/select-workspace";
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, 12);
}

router.get("/csrf", (_request, response) => {
  const token = createCsrfToken();
  setCsrfCookie(response, token);
  response.status(200).json({ csrfToken: token });
});

router.post("/login", loginLimiter, async (request, response) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Enter a valid email and password" } });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  let passwordMatches = false;
  try {
    passwordMatches = await compare(parsed.data.password, user?.passwordHash ?? dummyHash);
  } catch {
    passwordMatches = false;
  }
  if (!user || !passwordMatches) {
    response.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" } });
    return;
  }

const contexts = user.globalRole === GlobalRole.SUPER_ADMIN ? [] : await availableContexts(user.id);
  if (user.globalRole !== GlobalRole.SUPER_ADMIN && contexts.length === 0) {
    // A user whose only agency is suspended is locked out with an explicit 403 rather than
    // an opaque failure, and no session cookie is issued.
    const suspendedAgency = await prisma.agency.findFirst({
      where: { status: AgencyStatus.SUSPENDED, OR: [{ members: { some: { userId: user.id } } }, { clientMembers: { some: { userId: user.id } } }] },
      select: { name: true }
    });
    response.status(403).json(suspendedAgency
      ? { error: { code: "AGENCY_SUSPENDED", message: `This account belongs to ${suspendedAgency.name}, which is suspended. Workspace access is blocked until a Super Admin reactivates the agency.` } }
      : { error: { code: "ACCOUNT_UNAVAILABLE", message: "No active workspace is available for this account" } });
    return;
  }

  const selectedContext = contexts.length === 1 ? contexts[0] : undefined;
  const sessionToken = createSessionToken();
  await prisma.authSession.create({
    data: {
      id: sessionToken.tokenHash,
      userId: user.id,
      activeAgencyId: selectedContext?.agencyId ?? null,
      activeClientMembershipId: selectedContext?.type === "client" ? selectedContext.clientMembershipId : null,
      expiresAt: sessionToken.expiresAt
    }
  });
  setSessionCookie(response, sessionToken.token);

  const portal = user.globalRole === GlobalRole.SUPER_ADMIN
    ? "super-admin"
    : selectedContext?.type ?? "selection";
  response.status(200).json({
    user: { id: user.id, name: user.name, email: user.email, globalRole: user.globalRole },
    contexts,
    contextRequired: portal === "selection",
    redirectTo: contextRedirect(portal)
  });
});

const supportSessionSchema = z.object({ agencyId: z.string().min(1).max(30), reason: z.string().trim().min(10).max(500) }).strict();

router.post("/support-session", authenticate, requireSuperAdmin, async (request, response) => {
  const context = request.auth!;
  if (context.supportSessionId) {
    response.status(409).json({ error: { code: "SUPPORT_SESSION_ACTIVE", message: "End the current support session before entering another agency" } });
    return;
  }
  const parsed = supportSessionSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "An agency and a reason of 10 to 500 characters are required" } });
    return;
  }
  const openSupportSession = await prisma.supportSession.findFirst({
    where: { superAdminId: context.userId, endedAt: null },
    orderBy: { startedAt: "desc" }
  });
  if (openSupportSession) {
    const activeOwnerSession = await prisma.authSession.findFirst({
      where: { userId: context.userId, activeSupportSessionId: openSupportSession.id, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true }
    });
    if (activeOwnerSession) {
      response.status(409).json({ error: { code: "SUPPORT_SESSION_ACTIVE", message: "End the existing support session before entering another agency" } });
      return;
    }
    await prisma.$transaction(async (transaction) => {
      await transaction.supportSession.update({ where: { id: openSupportSession.id }, data: { endedAt: new Date() } });
      await transaction.authSession.updateMany({ where: { activeSupportSessionId: openSupportSession.id }, data: { activeSupportSessionId: null } });
    });
  }
  const agency = await prisma.agency.findUnique({ where: { id: parsed.data.agencyId }, select: { id: true, name: true } });
  if (!agency) {
    response.status(404).json({ error: { code: "NOT_FOUND", message: "Agency not found" } });
    return;
  }
const supportSession = await prisma.$transaction(async (transaction) => {
    const created = await transaction.supportSession.create({
      data: { superAdminId: context.userId, agencyId: agency.id, reason: parsed.data.reason }
    });
    await transaction.authSession.update({
      where: { id: context.sessionId },
      data: { activeSupportSessionId: created.id }
    });
    // Audit the entry exactly like the admin support-session route does. Without this,
    // a support session opened through this endpoint would leave no platform audit trail.
    await transaction.platformActivity.create({
      data: {
        actorId: context.userId,
        agencyId: agency.id,
        eventType: "support.started",
        entityType: "support_session",
        entityId: created.id,
        summary: `Started support session for ${agency.name}`,
        metadata: { reason: created.reason }
      }
    });
    return created;
  });
  response.status(201).json({ supportSessionId: supportSession.id, agency: { id: agency.id, name: agency.name }, reason: supportSession.reason });
});

router.delete("/support-session", authenticate, requireSuperAdmin, async (request, response) => {
  const context = request.auth!;
  if (!context.supportSessionId) {
    response.status(409).json({ error: { code: "SUPPORT_SESSION_REQUIRED", message: "There is no active support session" } });
    return;
  }
const supportSessionId = context.supportSessionId;
  const endedAt = new Date();
  await prisma.$transaction(async (transaction) => {
    await transaction.supportSession.updateMany({
      where: { id: supportSessionId, superAdminId: context.userId, endedAt: null },
      data: { endedAt }
    });
    await transaction.authSession.updateMany({
      where: { userId: context.userId, activeSupportSessionId: supportSessionId },
      data: { activeSupportSessionId: null }
    });
    // Audit the exit with the target agency resolved server-side, never from request input.
    const closed = await transaction.supportSession.findUnique({
      where: { id: supportSessionId },
      select: { agencyId: true, agency: { select: { name: true } }, reason: true }
    });
    if (closed) {
      await transaction.platformActivity.create({
        data: {
          actorId: context.userId,
          agencyId: closed.agencyId,
          eventType: "support.ended",
          entityType: "support_session",
          entityId: supportSessionId,
          summary: `Ended support session for ${closed.agency.name}`,
          metadata: { reason: closed.reason }
        }
      });
    }
  });
  response.status(200).json({ supportMode: false, endedAt });
});

router.get("/me", authenticate, async (request, response) => {
  const context = request.auth!;
  const [user, contexts] = await Promise.all([
    prisma.user.findUnique({ where: { id: context.userId }, select: { id: true, name: true, email: true, globalRole: true } }),
    context.portal === "super-admin" ? Promise.resolve([] as AvailableContext[]) : availableContexts(context.userId)
  ]);
  if (!user) {
    response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required" } });
    return;
  }
  response.status(200).json({
    user,
    portal: context.portal,
    activeContext: context.portal === "agency"
      ? { type: "agency", agencyId: context.agencyId, agencyName: context.agencyName, role: context.agencyRole }
      : context.portal === "client"
        ? { type: "client", agencyId: context.agencyId, agencyName: context.agencyName, clientId: context.clientId, clientName: context.clientName }
        : null,
    contexts,
    supportMode: context.supportSessionId ? { id: context.supportSessionId, agencyName: context.supportAgencyName } : null,
    contextRequired: context.portal === "selection",
    redirectTo: contextRedirect(context.portal)
  });
});

router.post("/context", authenticate, async (request, response) => {
  const context = request.auth!;
  if (context.globalRole === GlobalRole.SUPER_ADMIN) {
    response.status(403).json({ error: { code: "FORBIDDEN", message: "Super Admin sessions do not select agency contexts" } });
    return;
  }
  const parsed = contextSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({ error: { code: "VALIDATION_ERROR", message: "A valid workspace selection is required" } });
    return;
  }

  let activeAgencyId: string;
  let activeClientMembershipId: string | null = null;
  let portal: "agency" | "client";
  if (parsed.data.type === "agency") {
    const membership = await prisma.agencyMember.findFirst({
      where: { userId: context.userId, agencyId: parsed.data.agencyId, agency: { status: AgencyStatus.ACTIVE } },
      select: { agencyId: true }
    });
    if (!membership) {
      response.status(403).json({ error: { code: "FORBIDDEN", message: "This account is not a member of that active agency" } });
      return;
    }
    activeAgencyId = membership.agencyId;
    portal = "agency";
  } else {
    const membership = await prisma.clientMember.findFirst({
      where: { id: parsed.data.clientMembershipId, userId: context.userId, agency: { status: AgencyStatus.ACTIVE } },
      select: { id: true, agencyId: true }
    });
    if (!membership) {
      response.status(403).json({ error: { code: "FORBIDDEN", message: "This account is not a member of that active client" } });
      return;
    }
    activeAgencyId = membership.agencyId;
    activeClientMembershipId = membership.id;
    portal = "client";
  }

  await prisma.authSession.update({
    where: { id: context.sessionId },
    data: { activeAgencyId, activeClientMembershipId }
  });
  response.status(200).json({ portal, redirectTo: contextRedirect(portal) });
});

router.post("/logout", async (request, response) => {
  const token = request.cookies?.[SESSION_COOKIE] as string | undefined;
  if (token && token.length <= 200) {
    const tokenHash = hashSessionToken(token);
    const session = await prisma.authSession.findFirst({ where: { id: tokenHash, revokedAt: null } });
    if (session) {
      await prisma.$transaction(async (transaction) => {
        if (session.activeSupportSessionId) {
          await transaction.supportSession.updateMany({
            where: { id: session.activeSupportSessionId, superAdminId: session.userId, endedAt: null },
            data: { endedAt: new Date() }
          });
        }
        await transaction.authSession.updateMany({ where: { id: tokenHash, revokedAt: null }, data: { revokedAt: new Date(), activeSupportSessionId: null } });
      });
    }
  }
  clearSessionCookie(response);
  clearCsrfCookie(response);
  response.status(200).json({ signedOut: true });
});
export { router as authRouter };






