import {
  PrismaClient,
  AgencyRole,
  AgencyStatus,
  FeedbackStatus,
  FileVisibility,
  GlobalRole,
  MilestoneStatus,
  Priority,
  ProjectStatus,
  TaskStatus
} from "@prisma/client";
import { hash } from "bcryptjs";
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env") });

const prisma = new PrismaClient();

/**
 * Documented local evaluation password. `SEED_PASSWORD` overrides it for teams that
 * prefer their own local-only value; the seed refuses to run in production either way.
 */
const DEFAULT_EVALUATION_PASSWORD = "password123";

function assertLocalDatabase(): void {
  let target: URL;
  try {
    target = new URL(process.env.DATABASE_URL ?? "");
  } catch {
    throw new Error("The seed requires a valid local DATABASE_URL; refusing to continue");
  }
  if (
    target.protocol !== "mysql:" ||
    !["localhost", "127.0.0.1", "::1"].includes(target.hostname) ||
    target.pathname.slice(1) !== "appzex"
  ) {
    throw new Error("The seed refuses database targets other than the local appzex test database");
  }
}

function daysFromNow(days: number): Date {
  const value = new Date();
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() + days);
  return value;
}

type SeedUser = { id: string; name: string; email: string; globalRole?: GlobalRole };

/**
 * Seeded users are keyed on their deterministic id rather than on email so that renaming a
 * demo account (for example to match the assignment's credential table) updates the existing
 * row in place instead of leaving a duplicate behind. Re-running the seed is a no-op.
 */
async function upsertUser(data: SeedUser, passwordHash: string) {
  return prisma.user.upsert({
    where: { id: data.id },
    update: { name: data.name, email: data.email, passwordHash, globalRole: data.globalRole ?? GlobalRole.USER },
    create: { id: data.id, name: data.name, email: data.email, passwordHash, globalRole: data.globalRole ?? GlobalRole.USER }
  });
}

async function upsertAgency(input: { id: string; name: string; slug: string; status: AgencyStatus }) {
  const agency = await prisma.agency.upsert({
    where: { slug: input.slug },
    update: { name: input.name, status: input.status },
    create: { id: input.id, name: input.name, slug: input.slug, status: input.status }
  });
  await prisma.agencySettings.upsert({
    where: { agencyId: agency.id },
    update: { timezone: "UTC" },
    create: { agencyId: agency.id, timezone: "UTC" }
  });
  return agency;
}

async function upsertMembership(agencyId: string, userId: string, role: AgencyRole) {
  return prisma.agencyMember.upsert({
    where: { agencyId_userId: { agencyId, userId } },
    update: { role },
    create: { agencyId, userId, role }
  });
}

/**
 * Developer sample dataset. Kept because the project health-report integration suite
 * asserts tenant isolation against these two agencies.
 */
async function seedDeveloperSample(passwordHash: string) {
  const fixtures = [
    { agencyId: "agency_northstar", slug: "northstar-studio", name: "Northstar Studio", userId: "usr_northstar_owner", email: "owner@northstar.test", clientId: "client_northstar", clientUserId: "usr_northstar_client", clientEmail: "client@northstar.test", projectId: "project_northstar", taskId: "task_northstar" },
    { agencyId: "agency_lighthouse", slug: "lighthouse-creative", name: "Lighthouse Creative", userId: "usr_lighthouse_owner", email: "owner@lighthouse.test", clientId: "client_lighthouse", clientUserId: "usr_lighthouse_client", clientEmail: "client@lighthouse.test", projectId: "project_lighthouse", taskId: "task_lighthouse" }
  ];

  for (const fixture of fixtures) {
    const agency = await upsertAgency({ id: fixture.agencyId, name: fixture.name, slug: fixture.slug, status: AgencyStatus.ACTIVE });
    const owner = await upsertUser({ id: fixture.userId, name: `${fixture.name} Owner`, email: fixture.email }, passwordHash);
    await upsertMembership(agency.id, owner.id, AgencyRole.OWNER);
    const clientUser = await upsertUser({ id: fixture.clientUserId, name: `${fixture.name} Client`, email: fixture.clientEmail }, passwordHash);
    const client = await prisma.client.upsert({
      where: { agencyId_id: { agencyId: agency.id, id: fixture.clientId } },
      update: { companyName: `${fixture.name} Demo Client` },
      create: { id: fixture.clientId, agencyId: agency.id, companyName: `${fixture.name} Demo Client`, contactName: clientUser.name, email: clientUser.email }
    });
    await prisma.clientMember.upsert({
      where: { agencyId_clientId_userId: { agencyId: agency.id, clientId: client.id, userId: clientUser.id } },
      update: {},
      create: { agencyId: agency.id, clientId: client.id, userId: clientUser.id }
    });
    await prisma.project.upsert({
      where: { agencyId_id: { agencyId: agency.id, id: fixture.projectId } },
      update: { name: `${fixture.name} Demo Website` },
      create: { id: fixture.projectId, agencyId: agency.id, clientId: client.id, managerId: owner.id, name: `${fixture.name} Demo Website`, description: "Seed data for development and tenant-isolation work.", status: ProjectStatus.ACTIVE, priority: Priority.MEDIUM }
    });
    await prisma.task.upsert({
      where: { agencyId_id: { agencyId: agency.id, id: fixture.taskId } },
      update: { title: "Review project brief" },
      create: { id: fixture.taskId, agencyId: agency.id, projectId: fixture.projectId, assigneeId: owner.id, title: "Review project brief", status: TaskStatus.TODO, priority: Priority.MEDIUM }
    });
  }

  await upsertUser({ id: "usr_super_admin", name: "AppZex Super Admin", email: "admin@appzex.test", globalRole: GlobalRole.SUPER_ADMIN }, passwordHash);
  return fixtures.map((fixture) => fixture.email);
}

/**
 * Evaluation dataset required by the assignment: Super Admin, two isolated ACTIVE
 * agencies with admins/team/client users, and one SUSPENDED agency that must be locked out.
 */
async function seedEvaluationDataset(passwordHash: string) {
  const credentials: string[] = [];

  await upsertUser({ id: "usr_eval_superadmin", name: "AppZex Evaluation Super Admin", email: "superadmin@appzex.local", globalRole: GlobalRole.SUPER_ADMIN }, passwordHash);
  credentials.push("superadmin@appzex.local");

  // ---- Agency A: Apex Digital Marketing (ACTIVE) ----
  const apex = await upsertAgency({ id: "agc_eval_apex", name: "Apex Digital Marketing", slug: "apex-digital-marketing", status: AgencyStatus.ACTIVE });
  const apexAdmin = await upsertUser({ id: "usr_eval_apex_admin", name: "Avery Admin (Apex)", email: "admin@agencya.local" }, passwordHash);
  await upsertMembership(apex.id, apexAdmin.id, AgencyRole.ADMIN);
  const apexDeveloper = await upsertUser({ id: "usr_eval_apex_dev", name: "Devon Developer (Apex)", email: "dev@agencya.local" }, passwordHash);
  await upsertMembership(apex.id, apexDeveloper.id, AgencyRole.MEMBER);
  const apexClientUser = await upsertUser({ id: "usr_eval_apex_client", name: "Casey Client (ClientCorp A)", email: "client@companya.local" }, passwordHash);
  const apexClient = await prisma.client.upsert({
    where: { agencyId_id: { agencyId: apex.id, id: "cli_eval_clientcorp_a" } },
    update: { companyName: "ClientCorp A" },
    create: { id: "cli_eval_clientcorp_a", agencyId: apex.id, companyName: "ClientCorp A", contactName: apexClientUser.name, email: apexClientUser.email }
  });
  await prisma.clientMember.upsert({
    where: { agencyId_clientId_userId: { agencyId: apex.id, clientId: apexClient.id, userId: apexClientUser.id } },
    update: {},
    create: { agencyId: apex.id, clientId: apexClient.id, userId: apexClientUser.id }
  });

  const apexProject = await prisma.project.upsert({
    where: { agencyId_id: { agencyId: apex.id, id: "prj_eval_apex_site" } },
    update: { name: "Apex Marketing Site Relaunch", status: ProjectStatus.ACTIVE },
    create: {
      id: "prj_eval_apex_site",
      agencyId: apex.id,
      clientId: apexClient.id,
      managerId: apexAdmin.id,
      name: "Apex Marketing Site Relaunch",
      description: "Demonstrates derived progress: 5 tasks with 2 completed, 2 in progress and 1 overdue. Progress is never typed in.",
      status: ProjectStatus.ACTIVE,
      priority: Priority.HIGH,
      startDate: daysFromNow(-30),
      dueDate: daysFromNow(21)
    }
  });

  const apexTasks: Array<{ id: string; title: string; status: TaskStatus; priority: Priority; dueDate: Date | null; assigneeId: string }> = [
    { id: "tsk_eval_apex_1", title: "Discovery workshop and stakeholder interviews", status: TaskStatus.DONE, priority: Priority.HIGH, dueDate: daysFromNow(-20), assigneeId: apexAdmin.id },
    { id: "tsk_eval_apex_2", title: "Responsive design system approval", status: TaskStatus.DONE, priority: Priority.MEDIUM, dueDate: daysFromNow(-10), assigneeId: apexDeveloper.id },
    { id: "tsk_eval_apex_3", title: "Marketing site build", status: TaskStatus.IN_PROGRESS, priority: Priority.HIGH, dueDate: daysFromNow(14), assigneeId: apexDeveloper.id },
    { id: "tsk_eval_apex_4", title: "Analytics and conversion tracking", status: TaskStatus.IN_PROGRESS, priority: Priority.MEDIUM, dueDate: daysFromNow(30), assigneeId: apexAdmin.id },
    { id: "tsk_eval_apex_5", title: "Legacy content migration", status: TaskStatus.TODO, priority: Priority.URGENT, dueDate: daysFromNow(-5), assigneeId: apexDeveloper.id }
  ];
  for (const task of apexTasks) {
    const data = { agencyId: apex.id, projectId: apexProject.id, assigneeId: task.assigneeId, title: task.title, description: `Seeded evaluation task for ${apex.name}.`, status: task.status, priority: task.priority, dueDate: task.dueDate };
    await prisma.task.upsert({ where: { agencyId_id: { agencyId: apex.id, id: task.id } }, update: data, create: { id: task.id, ...data } });
  }

  const apexMilestones: Array<{ id: string; title: string; status: MilestoneStatus; dueDate: Date | null; position: number }> = [
    { id: "mls_eval_apex_1", title: "Discovery sign-off", status: MilestoneStatus.COMPLETED, dueDate: daysFromNow(-14), position: 1 },
    { id: "mls_eval_apex_2", title: "Beta launch", status: MilestoneStatus.IN_PROGRESS, dueDate: daysFromNow(10), position: 2 },
    { id: "mls_eval_apex_3", title: "Full site handover", status: MilestoneStatus.PENDING, dueDate: daysFromNow(21), position: 3 }
  ];
  for (const milestone of apexMilestones) {
    const data = { agencyId: apex.id, projectId: apexProject.id, title: milestone.title, status: milestone.status, dueDate: milestone.dueDate, position: milestone.position };
    await prisma.milestone.upsert({ where: { agencyId_projectId_id: { agencyId: apex.id, projectId: apexProject.id, id: milestone.id } }, update: data, create: { id: milestone.id, ...data } });
  }

  const meetingData = { agencyId: apex.id, projectId: apexProject.id, title: "Apex relaunch kickoff", scheduledAt: daysFromNow(-28), notes: "Shared kickoff notes. Client-visible to ClientCorp A.", clientVisible: true };
  await prisma.meeting.upsert({ where: { id: "mtg_eval_apex_kickoff" }, update: meetingData, create: { id: "mtg_eval_apex_kickoff", ...meetingData } });

  const feedbackData = { agencyId: apex.id, projectId: apexProject.id, submittedBy: apexClientUser.id, title: "Hero section headline feedback", description: "ClientCorp A would like the hero section to lead with the new value proposition.", status: FeedbackStatus.OPEN };
  await prisma.feedback.upsert({ where: { agencyId_id: { agencyId: apex.id, id: "fdb_eval_apex_hero" } }, update: feedbackData, create: { id: "fdb_eval_apex_hero", ...feedbackData } });

  await prisma.file.upsert({
    where: { storageKey: "seed/evaluation/apex-project-brief.txt" },
    update: { fileName: "Apex-Project-Brief.txt", visibility: FileVisibility.CLIENT_SHARED },
    create: { id: "fil_eval_apex_brief", agencyId: apex.id, projectId: apexProject.id, storageKey: "seed/evaluation/apex-project-brief.txt", fileName: "Apex-Project-Brief.txt", mimeType: "text/plain", sizeBytes: 512n, visibility: FileVisibility.CLIENT_SHARED }
  });

  await prisma.activityLog.upsert({
    where: { id: "act_eval_apex_seed" },
    update: { eventType: "project.seeded" },
    create: { id: "act_eval_apex_seed", agencyId: apex.id, actorId: apexAdmin.id, eventType: "project.seeded", entityType: "project", entityId: apexProject.id }
  });

  credentials.push(apexAdmin.email, apexDeveloper.email, apexClientUser.email);

  // ---- Agency B: Nexus Software Agency (ACTIVE, isolation target) ----
  const nexus = await upsertAgency({ id: "agc_eval_nexus", name: "Nexus Software Agency", slug: "nexus-software-agency", status: AgencyStatus.ACTIVE });
  const nexusAdmin = await upsertUser({ id: "usr_eval_nexus_admin", name: "Noor Admin (Nexus)", email: "admin@agencyb.local" }, passwordHash);
  await upsertMembership(nexus.id, nexusAdmin.id, AgencyRole.ADMIN);
  const nexusClientUser = await upsertUser({ id: "usr_eval_nexus_client", name: "Robin Client (ClientCorp B)", email: "client@companyb.local" }, passwordHash);
  const nexusDeveloper = await upsertUser({ id: "usr_eval_nexus_dev", name: "Devi Developer (Nexus)", email: "dev@agencyb.local" }, passwordHash);
  await upsertMembership(nexus.id, nexusDeveloper.id, AgencyRole.MEMBER);
  const nexusClient = await prisma.client.upsert({
    where: { agencyId_id: { agencyId: nexus.id, id: "cli_eval_clientcorp_b" } },
    update: { companyName: "ClientCorp B" },
    create: { id: "cli_eval_clientcorp_b", agencyId: nexus.id, companyName: "ClientCorp B", contactName: nexusClientUser.name, email: nexusClientUser.email }
  });
  await prisma.clientMember.upsert({
    where: { agencyId_clientId_userId: { agencyId: nexus.id, clientId: nexusClient.id, userId: nexusClientUser.id } },
    update: {},
    create: { agencyId: nexus.id, clientId: nexusClient.id, userId: nexusClientUser.id }
  });

  const nexusProject = await prisma.project.upsert({
    where: { agencyId_id: { agencyId: nexus.id, id: "prj_eval_nexus_portal" } },
    update: { name: "Nexus Customer Portal", status: ProjectStatus.ACTIVE },
    create: {
      id: "prj_eval_nexus_portal",
      agencyId: nexus.id,
      clientId: nexusClient.id,
      managerId: nexusAdmin.id,
      name: "Nexus Customer Portal",
      description: "Belongs exclusively to Nexus Software Agency and ClientCorp B. Used to prove tenant isolation from Agency A.",
      status: ProjectStatus.ACTIVE,
      priority: Priority.MEDIUM,
      startDate: daysFromNow(-14),
      dueDate: daysFromNow(45)
    }
  });

  const nexusTasks: Array<{ id: string; title: string; status: TaskStatus; priority: Priority; dueDate: Date | null; assigneeId: string }> = [
    { id: "tsk_eval_nexus_1", title: "Service architecture spike", status: TaskStatus.DONE, priority: Priority.HIGH, dueDate: daysFromNow(-7), assigneeId: nexusDeveloper.id },
    { id: "tsk_eval_nexus_2", title: "Single sign-on integration", status: TaskStatus.IN_PROGRESS, priority: Priority.HIGH, dueDate: daysFromNow(10), assigneeId: nexusAdmin.id }
  ];
  for (const task of nexusTasks) {
    const data = { agencyId: nexus.id, projectId: nexusProject.id, assigneeId: task.assigneeId, title: task.title, description: `Seeded evaluation task for ${nexus.name}.`, status: task.status, priority: task.priority, dueDate: task.dueDate };
    await prisma.task.upsert({ where: { agencyId_id: { agencyId: nexus.id, id: task.id } }, update: data, create: { id: task.id, ...data } });
  }

  const nexusMilestones: Array<{ id: string; title: string; status: MilestoneStatus; dueDate: Date | null; position: number }> = [
    { id: "mls_eval_nexus_1", title: "Architecture review", status: MilestoneStatus.COMPLETED, dueDate: daysFromNow(-5), position: 1 },
    { id: "mls_eval_nexus_2", title: "SSO pilot", status: MilestoneStatus.IN_PROGRESS, dueDate: daysFromNow(12), position: 2 }
  ];
  for (const milestone of nexusMilestones) {
    const data = { agencyId: nexus.id, projectId: nexusProject.id, title: milestone.title, status: milestone.status, dueDate: milestone.dueDate, position: milestone.position };
    await prisma.milestone.upsert({ where: { agencyId_projectId_id: { agencyId: nexus.id, projectId: nexusProject.id, id: milestone.id } }, update: data, create: { id: milestone.id, ...data } });
  }

  const nexusMeetingData = { agencyId: nexus.id, projectId: nexusProject.id, title: "Nexus portal scoping", scheduledAt: daysFromNow(-12), notes: "Scoping notes for the ClientCorp B portal. Client-visible.", clientVisible: true };
  await prisma.meeting.upsert({ where: { id: "mtg_eval_nexus_scoping" }, update: nexusMeetingData, create: { id: "mtg_eval_nexus_scoping", ...nexusMeetingData } });

  const nexusFeedbackData = { agencyId: nexus.id, projectId: nexusProject.id, submittedBy: nexusClientUser.id, title: "Portal navigation feedback", description: "ClientCorp B asked for a persistent left navigation on every portal page.", status: FeedbackStatus.IN_PROGRESS };
  await prisma.feedback.upsert({ where: { agencyId_id: { agencyId: nexus.id, id: "fdb_eval_nexus_nav" } }, update: nexusFeedbackData, create: { id: "fdb_eval_nexus_nav", ...nexusFeedbackData } });

  await prisma.activityLog.upsert({
    where: { id: "act_eval_nexus_seed" },
    update: { eventType: "project.seeded" },
    create: { id: "act_eval_nexus_seed", agencyId: nexus.id, actorId: nexusAdmin.id, eventType: "project.seeded", entityType: "project", entityId: nexusProject.id }
  });

  await prisma.file.upsert({
    where: { storageKey: "seed/evaluation/nexus-architecture.txt" },
    update: { fileName: "Nexus-Architecture.txt", visibility: FileVisibility.CLIENT_SHARED },
    create: { id: "fil_eval_nexus_arch", agencyId: nexus.id, projectId: nexusProject.id, storageKey: "seed/evaluation/nexus-architecture.txt", fileName: "Nexus-Architecture.txt", mimeType: "text/plain", sizeBytes: 384n, visibility: FileVisibility.CLIENT_SHARED }
  });

  credentials.push(nexusAdmin.email, nexusDeveloper.email, nexusClientUser.email);

  // ---- Suspended agency: locked out with HTTP 403 ----
  const stalled = await upsertAgency({ id: "agc_eval_stalled", name: "Stalled Creative", slug: "stalled-creative", status: AgencyStatus.SUSPENDED });
  const stalledAdmin = await upsertUser({ id: "usr_eval_stalled_admin", name: "Sam Suspended (Stalled Creative)", email: "admin@suspended.local" }, passwordHash);
  await upsertMembership(stalled.id, stalledAdmin.id, AgencyRole.ADMIN);
  credentials.push(stalledAdmin.email);

  return credentials;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to create development seed accounts in production");
  assertLocalDatabase();

  const seedPassword = process.env.SEED_PASSWORD?.trim() || DEFAULT_EVALUATION_PASSWORD;
  if (seedPassword.length < 8) throw new Error("Set SEED_PASSWORD to a local-only password of at least 8 characters before seeding");
  const seedPasswordHash = await hash(seedPassword, 12);

  const sampleCredentials = await seedDeveloperSample(seedPasswordHash);
  const evaluationCredentials = await seedEvaluationDataset(seedPasswordHash);

  const summary = { agencies: await prisma.agency.count(), users: await prisma.user.count(), projects: await prisma.project.count(), tasks: await prisma.task.count(), milestones: await prisma.milestone.count() };
  console.info("AppZex seed complete (idempotent; no destructive operations were performed).");
  console.info(`Records: ${summary.agencies} agencies, ${summary.users} users, ${summary.projects} projects, ${summary.tasks} tasks, ${summary.milestones} milestones.`);
  console.info(`Evaluation accounts: ${evaluationCredentials.join(", ")}`);
  console.info(`Developer sample accounts: ${sampleCredentials.join(", ")}`);
  console.info(`All seeded accounts share the local seed password (SEED_PASSWORD, default "${DEFAULT_EVALUATION_PASSWORD}"). Suspended agency: admin@suspended.local must receive HTTP 403.`);
}

main()
  .catch((error: unknown) => {
    console.error("Database seed failed", error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());