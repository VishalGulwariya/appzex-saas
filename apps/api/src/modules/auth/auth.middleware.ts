import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { AgencyStatus, GlobalRole } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { clearSessionCookie, SESSION_COOKIE } from "../../middleware/csrf.js";
import { env } from "../../config/env.js";

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function authenticate(request: Request, response: Response, next: NextFunction): Promise<void> {
  const token = request.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!token || token.length > 200) {
    response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required" } });
    return;
  }

  const session = await prisma.authSession.findFirst({
    where: { id: hashSessionToken(token), revokedAt: null, expiresAt: { gt: new Date() } },
    include: { user: { select: { id: true, globalRole: true } } }
  });
  if (!session) {
    clearSessionCookie(response);
    response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Session is invalid or expired" } });
    return;
  }

  if (session.user.globalRole === GlobalRole.SUPER_ADMIN) {
    const supportSession = session.activeSupportSessionId
      ? await prisma.supportSession.findFirst({
          where: { id: session.activeSupportSessionId, superAdminId: session.userId, endedAt: null },
          include: { agency: { select: { id: true, name: true } } }
        })
      : null;
    if (session.activeSupportSessionId && !supportSession) {
      await prisma.authSession.updateMany({ where: { id: session.id }, data: { activeSupportSessionId: null } });
    }
    request.auth = {
      userId: session.userId,
      globalRole: session.user.globalRole,
      portal: "super-admin",
      sessionId: session.id,
      ...(supportSession ? {
        supportSessionId: supportSession.id,
        supportAgencyId: supportSession.agencyId,
        supportAgencyName: supportSession.agency.name
      } : {})
    };
    next();
    return;
  }

  if (session.activeClientMembershipId) {
    const membership = await prisma.clientMember.findFirst({
      where: { id: session.activeClientMembershipId, userId: session.userId, ...(session.activeAgencyId ? { agencyId: session.activeAgencyId } : {}) },
      include: { agency: { select: { id: true, name: true, status: true } }, client: { select: { id: true, companyName: true } } }
    });
    if (!membership || membership.agency.status !== AgencyStatus.ACTIVE) {
      response.status(403).json({ error: { code: membership ? "AGENCY_SUSPENDED" : "CONTEXT_UNAVAILABLE", message: "The selected workspace is unavailable" } });
      return;
    }
    request.auth = {
      userId: session.userId,
      globalRole: session.user.globalRole,
      portal: "client",
      sessionId: session.id,
      agencyId: membership.agencyId,
      clientId: membership.clientId,
      clientMembershipId: membership.id,
      agencyName: membership.agency.name,
      clientName: membership.client.companyName
    };
    next();
    return;
  }

  if (session.activeAgencyId) {
    const membership = await prisma.agencyMember.findUnique({
      where: { agencyId_userId: { agencyId: session.activeAgencyId, userId: session.userId } },
      include: { agency: { select: { id: true, name: true, status: true } } }
    });
    if (!membership || membership.agency.status !== AgencyStatus.ACTIVE) {
      response.status(403).json({ error: { code: membership ? "AGENCY_SUSPENDED" : "CONTEXT_UNAVAILABLE", message: "The selected workspace is unavailable" } });
      return;
    }
    request.auth = {
      userId: session.userId,
      globalRole: session.user.globalRole,
      portal: "agency",
      sessionId: session.id,
      agencyId: membership.agencyId,
      agencyRole: membership.role,
      agencyName: membership.agency.name
    };
    next();
    return;
  }

  request.auth = { userId: session.userId, globalRole: session.user.globalRole, portal: "selection", sessionId: session.id };
  next();
}

export function requireAgencyContext(request: Request, response: Response, next: NextFunction): void {
  if (request.auth?.portal !== "agency" || !request.auth.agencyId || !request.auth.agencyRole) {
    response.status(request.auth?.portal === "selection" ? 409 : 403).json({
      error: { code: request.auth?.portal === "selection" ? "CONTEXT_REQUIRED" : "FORBIDDEN", message: "An active agency membership is required" }
    });
    return;
  }
  next();
}

export function requireClientContext(request: Request, response: Response, next: NextFunction): void {
  if (request.auth?.portal !== "client" || !request.auth.agencyId || !request.auth.clientId || !request.auth.clientMembershipId) {
    response.status(request.auth?.portal === "selection" ? 409 : 403).json({
      error: { code: request.auth?.portal === "selection" ? "CONTEXT_REQUIRED" : "FORBIDDEN", message: "An active client membership is required" }
    });
    return;
  }
  next();
}

export function requireSuperAdmin(request: Request, response: Response, next: NextFunction): void {
  if (request.auth?.globalRole !== GlobalRole.SUPER_ADMIN || request.auth.portal !== "super-admin") {
    response.status(403).json({ error: { code: "FORBIDDEN", message: "Super Admin access is required" } });
    return;
  }
  next();
}

export function requireSupportContext(request: Request, response: Response, next: NextFunction): void {
  if (request.auth?.globalRole !== GlobalRole.SUPER_ADMIN || !request.auth.supportSessionId || !request.auth.supportAgencyId) {
    response.status(403).json({ error: { code: "SUPPORT_SESSION_REQUIRED", message: "An explicit active support session is required" } });
    return;
  }
  next();
}

export function createSessionToken(): { token: string; tokenHash: string; expiresAt: Date } {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000)
  };
}

