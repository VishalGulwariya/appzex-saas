import { AgencyRole, FileVisibility } from "@prisma/client";
import type { RequestAuthContext } from "../types/express.js";
import { canPerform } from "../policies/authorization.js";
import { prisma } from "../lib/prisma.js";
import { tenantScope } from "./tenant-scope.js";

export async function findDownloadableFileForContext(context: RequestAuthContext, fileId: string) {
  const scope = tenantScope(context);
  const file = await prisma.file.findFirst({
    where: { agencyId: scope.agencyId, id: fileId },
    include: {
      project: {
        select: { clientId: true, managerId: true, tasks: { where: { assigneeId: scope.userId }, select: { id: true } } }
      },
      task: { select: { assigneeId: true, project: { select: { clientId: true, managerId: true } } } },
      feedback: {
        select: {
          project: { select: { clientId: true, managerId: true, tasks: { where: { assigneeId: scope.userId }, select: { id: true } } } }
        }
      }
    }
  });
  if (!file) return null;

  const relatedProject = file.project ?? file.task?.project ?? file.feedback?.project ?? null;
  const clientId = relatedProject?.clientId;
  const projectManagerId = relatedProject?.managerId;
  const assignedToUser = Boolean(
    file.task?.assigneeId === scope.userId ||
    file.project?.tasks.length ||
    file.feedback?.project.tasks.length
  );
  const isAgencyAdmin = context.agencyRole === AgencyRole.OWNER || context.agencyRole === AgencyRole.ADMIN;
  const permissionGranted = scope.kind === "support" || isAgencyAdmin ||
    (context.agencyRole === AgencyRole.PROJECT_MANAGER && (projectManagerId === scope.userId || assignedToUser)) ||
    (context.agencyRole === AgencyRole.MEMBER && assignedToUser);

  const allowed = canPerform("files:download", context, {
    agencyId: file.agencyId,
    ...(clientId ? { clientId } : {}),
    ...(projectManagerId !== undefined ? { projectManagerId } : {}),
    assignedToUser,
    permissionGranted,
    clientShared: file.visibility === FileVisibility.CLIENT_SHARED
  });
  if (!allowed) return null;

  const { project: _project, task: _task, feedback: _feedback, ...fileMetadata } = file;
  return fileMetadata;
}
