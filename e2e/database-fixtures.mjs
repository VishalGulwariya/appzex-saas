import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const requireFromApi = createRequire(resolve(process.cwd(), "apps/api/package.json"));
const { PrismaClient, AgencyRole, AgencyStatus, FeedbackStatus, MilestoneStatus, Priority, ProjectStatus, TaskStatus } = requireFromApi("@prisma/client");
const { hash } = requireFromApi("bcryptjs");
const { config } = requireFromApi("dotenv");

process.env.NODE_ENV = "test";
config({ path: resolve(process.cwd(), ".env") });

export function assertLocalTestDatabase() {
  let target;
  try {
    target = new URL(process.env.DATABASE_URL ?? "");
  } catch {
    throw new Error("E2E requires a valid local DATABASE_URL");
  }
  if (target.protocol !== "mysql:" || !["localhost", "127.0.0.1", "::1"].includes(target.hostname) || target.pathname.slice(1) !== "appzex") {
    throw new Error("E2E refuses database targets other than the established local appzex test database");
  }
}

export async function createFixtures() {
  assertLocalTestDatabase();
  const prisma = new PrismaClient();
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const password = randomBytes(24).toString("base64url");
  const passwordHash = await hash(password, 12);
  const assignedProjectName = `E2E_PROJECT_10D_${runId}_ASSIGNED`;
  const unassignedProjectName = `E2E_PROJECT_10D_${runId}_UNASSIGNED`;
  const otherTenantProjectName = `E2E_PROJECT_10D_${runId}_TENANT_B`;

  try {
    const created = await prisma.$transaction(async (tx) => {
      const agencyA = await tx.agency.create({ data: { name: `E2E_AGENCY_10D_${runId}_A`, slug: `e2e-10d-${runId}-a`, status: AgencyStatus.ACTIVE } });
      const agencyB = await tx.agency.create({ data: { name: `E2E_AGENCY_10D_${runId}_B`, slug: `e2e-10d-${runId}-b`, status: AgencyStatus.ACTIVE } });
      const clientA = await tx.client.create({ data: { agencyId: agencyA.id, companyName: `E2E_CLIENT_10D_${runId}_A` } });
      const clientB = await tx.client.create({ data: { agencyId: agencyB.id, companyName: `E2E_CLIENT_10D_${runId}_B` } });
      const ownerA = await tx.user.create({ data: { name: `E2E_OWNER_10D_${runId}_A`, email: `owner-a-${runId}@e2e.invalid`, passwordHash } });
      const memberA = await tx.user.create({ data: { name: `E2E_MEMBER_10D_${runId}`, email: `member-${runId}@e2e.invalid`, passwordHash } });
      const ownerB = await tx.user.create({ data: { name: `E2E_OWNER_10D_${runId}_B`, email: `owner-b-${runId}@e2e.invalid`, passwordHash } });
      await tx.agencyMember.createMany({ data: [
        { agencyId: agencyA.id, userId: ownerA.id, role: AgencyRole.OWNER },
        { agencyId: agencyA.id, userId: memberA.id, role: AgencyRole.MEMBER },
        { agencyId: agencyB.id, userId: ownerB.id, role: AgencyRole.OWNER }
      ] });

      const assignedProject = await tx.project.create({ data: {
        agencyId: agencyA.id, clientId: clientA.id, managerId: ownerA.id,
        name: assignedProjectName,
        description: `Synthetic browser test project ${runId}.`,
        status: ProjectStatus.ACTIVE, priority: Priority.MEDIUM
      } });
      const unassignedProject = await tx.project.create({ data: {
        agencyId: agencyA.id, clientId: clientA.id, managerId: ownerA.id,
        name: unassignedProjectName,
        description: `Synthetic unassigned project ${runId}.`,
        status: ProjectStatus.ACTIVE, priority: Priority.MEDIUM
      } });
      const otherTenantProject = await tx.project.create({ data: {
        agencyId: agencyB.id, clientId: clientB.id, managerId: ownerB.id,
        name: otherTenantProjectName,
        description: `Synthetic other-tenant project ${runId}.`,
        status: ProjectStatus.ACTIVE, priority: Priority.MEDIUM
      } });
      const memberTask = await tx.task.create({ data: {
        agencyId: agencyA.id, projectId: assignedProject.id, assigneeId: memberA.id,
        title: `E2E_TASK_10D_${runId}_MEMBER`, description: "Synthetic assigned task.",
        status: TaskStatus.TODO, priority: Priority.MEDIUM
      } });
      const ownerTask = await tx.task.create({ data: {
        agencyId: agencyA.id, projectId: assignedProject.id, assigneeId: ownerA.id,
        title: `E2E_TASK_10D_${runId}_OWNER`, description: "Synthetic completed task.",
        status: TaskStatus.DONE, priority: Priority.LOW
      } });
      const unassignedTask = await tx.task.create({ data: {
        agencyId: agencyA.id, projectId: unassignedProject.id, assigneeId: ownerA.id,
        title: `E2E_TASK_10D_${runId}_UNASSIGNED`, status: TaskStatus.TODO, priority: Priority.LOW
      } });
      const otherTenantTask = await tx.task.create({ data: {
        agencyId: agencyB.id, projectId: otherTenantProject.id, assigneeId: ownerB.id,
        title: `E2E_TASK_10D_${runId}_TENANT_B`, status: TaskStatus.TODO, priority: Priority.LOW
      } });
      const milestone = await tx.milestone.create({ data: {
        agencyId: agencyA.id, projectId: assignedProject.id,
        title: `E2E_MILESTONE_10D_${runId}`,
        dueDate: new Date(Date.now() + 7 * 86400000), status: MilestoneStatus.PENDING
      } });
      const feedback = await tx.feedback.create({ data: {
        agencyId: agencyA.id, projectId: assignedProject.id,
        title: `E2E_FEEDBACK_10D_${runId}`, description: "Synthetic feedback for browser verification.",
        status: FeedbackStatus.OPEN
      } });
      const meeting = await tx.meeting.create({ data: {
        agencyId: agencyA.id, projectId: assignedProject.id,
        title: `E2E_PRIVATE_MEETING_10D_${runId}`, scheduledAt: new Date(),
        notes: `PRIVATE_MEETING_SENTINEL_10D_${runId}`, clientVisible: false
      } });
      const file = await tx.file.create({ data: {
        agencyId: agencyA.id, projectId: assignedProject.id,
        storageKey: `e2e-${runId}-private.txt`, fileName: `PRIVATE_FILE_SENTINEL_10D_${runId}.txt`,
        mimeType: "text/plain", sizeBytes: 1n
      } });
      await tx.activityLog.create({ data: {
        agencyId: agencyA.id, eventType: `E2E_ACTIVITY_10D_${runId}`,
        entityType: "project", entityId: assignedProject.id
      } });

      return {
        runId, password,
        ownerEmail: ownerA.email,
        memberEmail: memberA.email,
        otherOwnerEmail: ownerB.email,
        assignedProjectName,
        unassignedProjectName,
        otherTenantProjectName,
        agencyIds: [agencyA.id, agencyB.id],
        userIds: [ownerA.id, memberA.id, ownerB.id],
        projectIds: [assignedProject.id, unassignedProject.id, otherTenantProject.id],
        assignedProjectId: assignedProject.id,
        unassignedProjectId: unassignedProject.id,
        otherTenantProjectId: otherTenantProject.id,
        taskIds: [memberTask.id, ownerTask.id, unassignedTask.id, otherTenantTask.id],
        memberTaskId: memberTask.id,
        ownerTaskId: ownerTask.id,
        otherTenantTaskId: otherTenantTask.id
      };
    });
    return created;
  } catch (error) {
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

export async function readProjectState(projectId, taskIds) {
  assertLocalTestDatabase();
  const prisma = new PrismaClient();
  try {
    const [project, tasks] = await Promise.all([
      prisma.project.findUnique({ where: { id: projectId }, select: { status: true } }),
      prisma.task.findMany({ where: { id: { in: taskIds } }, orderBy: { id: "asc" }, select: { id: true, status: true } })
    ]);
    return { project, tasks };
  } finally {
    await prisma.$disconnect();
  }
}

export async function cleanupFixtures(fixture) {
  if (!fixture?.agencyIds?.length) return;
  assertLocalTestDatabase();
  const prisma = new PrismaClient();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.authSession.deleteMany({ where: { userId: { in: fixture.userIds } } });
      await tx.file.deleteMany({ where: { agencyId: { in: fixture.agencyIds } } });
      await tx.meeting.deleteMany({ where: { agencyId: { in: fixture.agencyIds } } });
      await tx.feedback.deleteMany({ where: { agencyId: { in: fixture.agencyIds } } });
      await tx.activityLog.deleteMany({ where: { agencyId: { in: fixture.agencyIds } } });
      await tx.task.deleteMany({ where: { agencyId: { in: fixture.agencyIds } } });
      await tx.milestone.deleteMany({ where: { agencyId: { in: fixture.agencyIds } } });
      await tx.project.deleteMany({ where: { id: { in: fixture.projectIds } } });
      await tx.clientMember.deleteMany({ where: { agencyId: { in: fixture.agencyIds } } });
      await tx.client.deleteMany({ where: { agencyId: { in: fixture.agencyIds } } });
      await tx.agencyMember.deleteMany({ where: { agencyId: { in: fixture.agencyIds } } });
      await tx.agencySettings.deleteMany({ where: { agencyId: { in: fixture.agencyIds } } });
      await tx.agency.deleteMany({ where: { id: { in: fixture.agencyIds } } });
      await tx.user.deleteMany({ where: { id: { in: fixture.userIds } } });
    });
  } finally {
    await prisma.$disconnect();
  }
}