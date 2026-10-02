import express, { Router, type NextFunction, type Request, type Response } from "express";
import { createReadStream } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { ActivityVisibility, AgencyRole, FileVisibility } from "@prisma/client";
import { authenticate } from "../auth/auth.middleware.js";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { canPerform } from "../../policies/authorization.js";
import { findDownloadableFileForContext } from "../../repositories/files.repository.js";
import { findProjectForContext, listProjectsForContext } from "../../repositories/projects.repository.js";
import { tenantScope } from "../../repositories/tenant-scope.js";

export const filesRouter = Router();
filesRouter.use(authenticate);filesRouter.use(async (request, _response, next) => {
  const context = request.auth;
  if (context?.portal === "super-admin" && context.supportSessionId && context.supportAgencyId) {
    await prisma.platformActivity.create({ data: { actorId: context.userId, agencyId: context.supportAgencyId, eventType: `support.files.${request.method.toLowerCase()}`, entityType: "agency_file_access", entityId: context.supportAgencyId, summary: `Support mode ${request.method} ${request.path}`.slice(0, 500), metadata: { supportSessionId: context.supportSessionId, method: request.method, path: request.path } } });
  }
  next();
});
const maxFileBytes = 10 * 1024 * 1024;
const supportedTypes: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", txt: "text/plain", csv: "text/csv" };
function workspaceContext(request: Request) {
  const context = request.auth!;
  if (context.portal === "agency" || (context.portal === "super-admin" && context.supportSessionId && context.supportAgencyId)) return tenantScope(context);
  return null;
}
function safeName(raw: string | undefined): string | null {
  if (!raw || raw.length > 800) return null;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  const leaf = basename(decoded.replaceAll("\\", "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return leaf && leaf.length <= 255 && leaf !== "." && leaf !== ".." ? leaf : null;
}
function detectMime(bytes: Buffer, extension: string): string | null {
  const claimed = supportedTypes[extension.toLowerCase()]; if (!claimed || bytes.length === 0) return null;
  if (extension === "pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-" ? claimed : null;
  if (extension === "png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? claimed : null;
  if (extension === "jpg" || extension === "jpeg") return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? claimed : null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return !text.includes("\0") ? claimed : null;
  } catch { return null; }
}
function isAgencyAdmin(request: Request) { return request.auth?.portal === "super-admin" || request.auth?.agencyRole === AgencyRole.OWNER || request.auth?.agencyRole === AgencyRole.ADMIN; }

filesRouter.get("/agency", async (request, response) => {
  const scope = workspaceContext(request); if (!scope) { response.status(403).json({ error: { code: "FORBIDDEN", message: "An agency workspace is required" } }); return; }
  const projects = await listProjectsForContext(request.auth!, { take: 200 }); const ids = projects.map((project) => project.id);
  const rows = ids.length ? await prisma.file.findMany({ where: { agencyId: scope.agencyId, OR: [{ projectId: { in: ids } }, { task: { projectId: { in: ids } } }, { feedback: { projectId: { in: ids } } }] }, orderBy: { createdAt: "desc" }, take: 100, include: { project: { select: { id: true, name: true } }, task: { select: { project: { select: { id: true, name: true } } } }, feedback: { select: { project: { select: { id: true, name: true } } } } } }) : [];
  const items = (await Promise.all(rows.map(async (row) => {
    const allowed = await findDownloadableFileForContext(request.auth!, row.id); if (!allowed) return null;
    return { id: row.id, fileName: row.fileName, mimeType: row.mimeType, sizeBytes: row.sizeBytes.toString(), visibility: row.visibility, createdAt: row.createdAt, project: row.project ?? row.task?.project ?? row.feedback?.project ?? null };
  }))).filter((item) => item !== null);
  response.json({ items });
});

filesRouter.post("/agency", expressRaw, async (request, response) => {
  const scope = workspaceContext(request); if (!scope) { response.status(403).json({ error: { code: "FORBIDDEN", message: "An agency workspace is required" } }); return; }
  if (!Buffer.isBuffer(request.body)) { response.status(400).json({ error: { code: "INVALID_FILE", message: "Send a file as application/octet-stream" } }); return; }
  const bytes = request.body as Buffer; if (bytes.length < 1 || bytes.length > maxFileBytes) { response.status(413).json({ error: { code: "FILE_SIZE_LIMIT", message: "Files must be between 1 byte and 10 MB" } }); return; }
  const projectId = request.get("x-project-id") ?? ""; const taskId = request.get("x-task-id") || undefined; const feedbackId = request.get("x-feedback-id") || undefined;
  const fileName = safeName(request.get("x-file-name")); if (!fileName) { response.status(400).json({ error: { code: "INVALID_FILE_NAME", message: "Provide a valid file name" } }); return; }
  const extension = extname(fileName).slice(1).toLowerCase(); const mimeType = detectMime(bytes, extension);
  if (!mimeType) { response.status(415).json({ error: { code: "UNSUPPORTED_FILE_TYPE", message: "Allowed types: PDF, PNG, JPEG, TXT, and CSV" } }); return; }
  const visibilityHeader = request.get("x-file-visibility"); const visibility = visibilityHeader === FileVisibility.CLIENT_SHARED && isAgencyAdmin(request) ? FileVisibility.CLIENT_SHARED : FileVisibility.INTERNAL;
  if (visibilityHeader === FileVisibility.CLIENT_SHARED && !isAgencyAdmin(request)) { response.status(403).json({ error: { code: "FORBIDDEN", message: "Only agency admins can share files with clients" } }); return; }
  const project = await findProjectForContext(request.auth!, projectId); if (!project) { response.status(404).json({ error: { code: "NOT_FOUND", message: "Project not found" } }); return; }
  if (taskId && !await prisma.task.findFirst({ where: { id: taskId, agencyId: scope.agencyId, projectId }, select: { id: true } })) { response.status(400).json({ error: { code: "INVALID_TASK", message: "Choose a task in the selected project" } }); return; }
  if (feedbackId && !await prisma.feedback.findFirst({ where: { id: feedbackId, agencyId: scope.agencyId, projectId }, select: { id: true } })) { response.status(400).json({ error: { code: "INVALID_FEEDBACK", message: "Choose feedback in the selected project" } }); return; }
  if (taskId && feedbackId) { response.status(400).json({ error: { code: "INVALID_FILE_TARGET", message: "Attach a file to a project, task, or feedback item, not multiple targets" } }); return; }
  const assignedTask = await prisma.task.findFirst({ where: { agencyId: scope.agencyId, projectId, assigneeId: request.auth!.userId }, select: { id: true } });
  const permissionGranted = scope.kind === "support" || isAgencyAdmin(request) || (request.auth!.agencyRole === AgencyRole.PROJECT_MANAGER && (project.managerId === request.auth!.userId || Boolean(assignedTask))) || (request.auth!.agencyRole === AgencyRole.MEMBER && Boolean(assignedTask));
  if (!canPerform("files:download", request.auth!, { agencyId: scope.agencyId, clientId: project.clientId, projectManagerId: project.managerId, assignedToUser: Boolean(assignedTask), permissionGranted })) { response.status(403).json({ error: { code: "FORBIDDEN", message: "You cannot add files to this project" } }); return; }
  const storageRoot = resolve(env.FILE_STORAGE_PATH); await mkdir(storageRoot, { recursive: true });
  const storageKey = `${randomUUID()}.${extension}`; const storagePath = resolve(storageRoot, storageKey);
  try {
    await writeFile(storagePath, bytes, { flag: "wx", mode: 0o600 });
    const file = await prisma.$transaction(async (tx) => {
      const created = await tx.file.create({ data: { agencyId: scope.agencyId, projectId, ...(taskId ? { taskId } : {}), ...(feedbackId ? { feedbackId } : {}), storageKey, fileName, mimeType, sizeBytes: BigInt(bytes.length), visibility } });
      await tx.activityLog.create({ data: { agencyId: scope.agencyId, actorId: request.auth!.portal === "agency" ? request.auth!.userId : null, eventType: "file.uploaded", entityType: "project", entityId: projectId, visibility: visibility === FileVisibility.CLIENT_SHARED ? ActivityVisibility.CLIENT_VISIBLE : ActivityVisibility.INTERNAL } });
      return created;
    });
    response.status(201).json({ file: { id: file.id, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.sizeBytes.toString(), visibility: file.visibility, createdAt: file.createdAt } });
  } catch (error) { await unlink(storagePath).catch(() => undefined); throw error; }
});

filesRouter.get("/:id/download", async (request, response, next) => {
  const file = await findDownloadableFileForContext(request.auth!, request.params.id);
  if (!file) { response.status(404).json({ error: { code: "NOT_FOUND", message: "File not found" } }); return; }
  const root = resolve(env.FILE_STORAGE_PATH); const path = resolve(root, file.storageKey); const rel = relative(root, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) { response.status(404).json({ error: { code: "NOT_FOUND", message: "File not found" } }); return; }
  response.attachment(file.fileName); response.type(file.mimeType); response.setHeader("X-Content-Type-Options", "nosniff");
  try { await pipeline(createReadStream(path), response); }
  catch (error) { if (response.headersSent) response.destroy(error instanceof Error ? error : new Error("File stream failed")); else next(error); }
});

function expressRaw(request: Request, response: Response, next: NextFunction) {
  express.raw({ type: "application/octet-stream", limit: maxFileBytes })(request, response, next);
}

