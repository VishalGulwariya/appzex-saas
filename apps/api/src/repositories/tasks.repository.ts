import { Prisma } from "@prisma/client";
import type { RequestAuthContext } from "../types/express.js";
import { prisma } from "../lib/prisma.js";
import { canPerform } from "../policies/authorization.js";
import { AuthorizationError, tenantScope } from "./tenant-scope.js";

function taskWhere(context: RequestAuthContext, projectId?: string): Prisma.TaskWhereInput {
  const scope = tenantScope(context);
  if (scope.kind === "client") throw new AuthorizationError("Client contexts do not have agency task access");
  const where: Prisma.TaskWhereInput = { agencyId: scope.agencyId };
  if (projectId) where.projectId = projectId;
  if (scope.assignedOnly) where.assigneeId = scope.userId;
  if (scope.managedOnly) {
    where.OR = [
      { assigneeId: scope.userId },
      { project: { managerId: scope.userId } }
    ];
  }
  return where;
}

function taskPermission(context: RequestAuthContext, task: { agencyId: string; assigneeId: string | null; project: { managerId: string | null } }): boolean {
  return canPerform("tasks:view", context, {
    agencyId: task.agencyId,
    taskAssigneeId: task.assigneeId,
    projectManagerId: task.project.managerId
  });
}

export async function listTasksForContext(context: RequestAuthContext, projectId?: string, take: number | null = 200) {
  const tasks = await prisma.task.findMany({
    where: taskWhere(context, projectId),
    include: { project: { select: { id: true, name: true, managerId: true } } },
    orderBy: { updatedAt: "desc" },
    ...(take === null ? {} : { take })
  });
  return tasks.filter((task) => taskPermission(context, task));
}

export async function findTaskForContext(context: RequestAuthContext, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { ...taskWhere(context), id: taskId },
    include: { project: { select: { managerId: true } } }
  });
  return task && taskPermission(context, task) ? task : null;
}




