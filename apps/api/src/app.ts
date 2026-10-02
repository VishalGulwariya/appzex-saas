import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { env } from "./config/env.js";
import { csrfProtection } from "./middleware/csrf.js";
import { requestId } from "./middleware/request-id.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { adminRouter } from "./modules/admin/admin.routes.js";
import { agencyRouter } from "./modules/agency/agency.routes.js";
import { clientRouter } from "./modules/client/client.routes.js";
import { communicationsRouter } from "./modules/communications/agency.routes.js";
import { filesRouter } from "./modules/communications/files.routes.js";
import { AuthorizationError } from "./repositories/tenant-scope.js";

export const app = express();

app.disable("x-powered-by");
app.use(requestId);
app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use("/api/v1", csrfProtection);
app.use("/api/v1/auth", authRouter);
app.use("/api/v1/admin", adminRouter);
app.use("/api/v1/agency", agencyRouter);
app.use("/api/v1/agency", communicationsRouter);
app.use("/api/v1/files", filesRouter);
app.use("/api/v1/client", clientRouter);

app.get("/api/v1/health", (_request, response) => {
  response.status(200).json({ status: "ok" });
});

app.use((_request, response) => {
  response.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
});

app.use((error: unknown, request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof AuthorizationError) {
    response.status(403).json({ error: { code: "FORBIDDEN", message: error.message } });
    return;
  }
  if (typeof error === "object" && error !== null && "status" in error && error.status === 413) {
    response.status(413).json({ error: { code: "FILE_SIZE_LIMIT", message: "Request body exceeds the allowed size" } });
    return;
  }
  console.error("Unhandled request error", { requestId: request.id, errorType: error instanceof Error ? error.name : "UnknownError" });
  response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } });
});






