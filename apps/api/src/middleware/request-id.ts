import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const requestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestId(request: Request, response: Response, next: NextFunction): void {
  const providedId = request.get("x-request-id")?.trim();
  request.id = providedId && requestIdPattern.test(providedId) ? providedId : randomUUID();
  response.setHeader("x-request-id", request.id);
  next();
}