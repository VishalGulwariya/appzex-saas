import { Prisma, type ProjectStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import type { RequestAuthContext } from "../types/express.js";
import { canPerform } from "../policies/authorization.js";
import { tenantScope } from "./tenant-scope.js";

export type ProjectFilters = { status?: ProjectStatus; clientId?: string; search?: string; take?: number };

function projectWhere(context: RequestAuthContext, filters: ProjectFilters): Prisma.ProjectWhereInput {
  const scope = tenantScope(context);
  const where: Prisma.ProjectWhereInput = { agencyId: scope.agencyId };
  if (filters.status) where.status = filters.status;
  if (filters.search?.trim()) where.name = { contains: filters.search.trim() };
  if (scope.kind === "client") where.clientId = scope.clientId;
  else { const clientId = filters.clientId; if (clientId) where.clientId = clientId; }
  if (scope.assignedOnly) {
    where.OR = [
      { managerId: scope.userId },
      { tasks: { some: { assigneeId: scope.userId } } }
    ];
  }
  return where;
}

const assignedTasksSelect = (userId: string) => ({
  tasks: { where: { assigneeId: userId }, select: { id: true } }
});

function projectPermission(context: RequestAuthContext, project: { agencyId: string; clientId: string; managerId: string | null }, assignedToUser = false): boolean {
  return canPerform("projects:view", context, {
    agencyId: project.agencyId,
    clientId: project.clientId,
    projectManagerId: project.managerId,
    assignedToUser
  });
}

export async function listProjectsForContext(context: RequestAuthContext, filters: ProjectFilters = {}) {
  const scope = tenantScope(context);
  const projects = await prisma.project.findMany({
    where: projectWhere(context, filters),
    ...(scope.assignedOnly ? { include: assignedTasksSelect(scope.userId) } : {}),
    orderBy: { updatedAt: "desc" },
    take: Math.min(Math.max(filters.take ?? 100, 1), 200)
  });
  return projects.filter((project) => projectPermission(context, project, scope.assignedOnly));
}

export async function findProjectForContext(context: RequestAuthContext, projectId: string) {
  const scope = tenantScope(context);
  const project = await prisma.project.findFirst({
    where: { ...projectWhere(context, {}), id: projectId },
    ...(scope.assignedOnly ? { include: assignedTasksSelect(scope.userId) } : {})
  });
  return project && projectPermission(context, project, scope.assignedOnly) ? project : null;
}


