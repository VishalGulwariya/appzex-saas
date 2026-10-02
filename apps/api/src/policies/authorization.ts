import { AgencyRole, GlobalRole } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import type { RequestAuthContext } from "../types/express.js";
import { prisma } from "../lib/prisma.js";

export const permissionActions = [
  "agencies:list", "agencies:suspend", "team:manage", "clients:create", "projects:create",
  "tasks:manage", "tasks:view", "projects:view", "feedback:submit", "notes:view", "files:download"
] as const;
export type PermissionAction = typeof permissionActions[number];

export type PermissionResource = {
  agencyId?: string;
  clientId?: string;
  projectManagerId?: string | null;
  taskAssigneeId?: string | null;
  assignedToUser?: boolean;
  permissionGranted?: boolean;
  clientShared?: boolean;
};

export type PolicyOptions = { allowMemberCreation?: boolean };

const adminActions = new Set<PermissionAction>([
  "team:manage", "clients:create", "projects:create", "tasks:manage", "tasks:view", "projects:view", "notes:view", "files:download"
]);

export function canPerform(
  action: PermissionAction,
  context: RequestAuthContext,
  resource?: PermissionResource,
  options: PolicyOptions = {}
): boolean {
  if (context.globalRole === GlobalRole.SUPER_ADMIN) {
    if (action === "agencies:list") return context.portal === "super-admin";
    if (action === "agencies:suspend") return context.portal === "super-admin" && Boolean(resource?.agencyId);
    if (action === "feedback:submit") return false;
    return Boolean(
      context.portal === "super-admin" && context.supportSessionId && context.supportAgencyId &&
      resource?.agencyId === context.supportAgencyId && adminActions.has(action)
    );
  }

  if (action === "agencies:list" || action === "agencies:suspend") return false;
  if (!resource?.agencyId) return false;

  if (context.portal === "agency" && context.agencyId === resource.agencyId && context.agencyRole) {
    const isAdmin = context.agencyRole === AgencyRole.OWNER || context.agencyRole === AgencyRole.ADMIN;
    if (action === "feedback:submit") return false;
    if (isAdmin) return adminActions.has(action);
    if ((action === "clients:create" || action === "projects:create") && options.allowMemberCreation) return true;
    if (action === "projects:view") {
      return context.agencyRole === AgencyRole.PROJECT_MANAGER || Boolean(resource.assignedToUser) || resource.projectManagerId === context.userId;
    }
    if (action === "tasks:view") {
      if (context.agencyRole === AgencyRole.PROJECT_MANAGER && resource.projectManagerId === context.userId) return true;
      return resource.taskAssigneeId === context.userId;
    }
    if (action === "tasks:manage") {
      if (context.agencyRole === AgencyRole.PROJECT_MANAGER && resource.projectManagerId === context.userId) return true;
      return resource.taskAssigneeId === context.userId;
    }
    if (action === "notes:view") {
      return context.agencyRole === AgencyRole.PROJECT_MANAGER && resource.projectManagerId === context.userId || Boolean(resource.assignedToUser);
    }
    if (action === "files:download") return Boolean(resource.permissionGranted);
    return false;
  }

  if (context.portal === "client" && context.agencyId === resource.agencyId && context.clientId) {
    if (action === "projects:view" || action === "feedback:submit") return resource.clientId === context.clientId;
    if (action === "files:download") return resource.clientId === context.clientId && Boolean(resource.clientShared);
    return false;
  }

  return false;
}

export type PermissionResourceResolver = (request: Request, context: RequestAuthContext) => PermissionResource | Promise<PermissionResource>;

export function requirePermission(action: PermissionAction, resolveResource?: PermissionResourceResolver, options: PolicyOptions = {}) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const context = request.auth;
    if (!context) {
      response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required" } });
      return;
    }
    const resource = resolveResource ? await resolveResource(request, context) : undefined;
    if (!canPerform(action, context, resource, options)) {
      response.status(403).json({ error: { code: "FORBIDDEN", message: "You do not have permission to perform this action" } });
      return;
    }
    if (context.globalRole === GlobalRole.SUPER_ADMIN && context.supportSessionId && context.supportAgencyId) {
      const routeEntityId = Object.values(request.params)[0];
      await prisma.platformActivity.create({ data: {
        actorId: context.userId,
        agencyId: context.supportAgencyId,
        eventType: `support.access.${action}`,
        entityType: "authorized_action",
        entityId: typeof routeEntityId === "string" ? routeEntityId : context.supportSessionId,
        summary: `Support mode ${action} on ${request.method} ${request.path}`,
        metadata: { supportSessionId: context.supportSessionId, action, method: request.method, path: request.path }
      } });
    }
    next();
  };
}






