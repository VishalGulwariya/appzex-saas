import type { NextFunction, Request, RequestHandler, Response } from "express";

type Bucket = { startedAt: number; count: number };
type RateLimitOptions = { limit?: number; windowMs?: number; now?: () => number };
export type AiRateLimitVerdict = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export const RATE_LIMIT_MESSAGE = "Health report generation limit exceeded. Please try again later.";

export function createAiRateLimiter(options: RateLimitOptions = {}) {
  const limit = options.limit ?? 5;
  const windowMs = options.windowMs ?? 10 * 60 * 1000;
  const now = options.now ?? Date.now;
  if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs < 1) {
    throw new Error("AI rate limiter requires a positive limit and window");
  }

  const buckets = new Map<string, Bucket>();

  /**
   * Consumes one token for the tenant (or user) bucket. Routes call this directly when they
   * need to attach backend-calculated metrics to a rate-limited response instead of returning a
   * bare error body.
   */
  const evaluate = (request: Request): AiRateLimitVerdict => {
    const timestamp = now();
    for (const [key, bucket] of buckets) {
      if (timestamp - bucket.startedAt >= windowMs) buckets.delete(key);
    }

    const context = request.auth;
    const tenantId = context?.agencyId ?? context?.supportAgencyId;
    const key = tenantId ? `tenant:${tenantId}` : `user:${context?.userId ?? request.ip}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { startedAt: timestamp, count: 0 };
      buckets.set(key, bucket);
    }

    if (bucket.count >= limit) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.startedAt + windowMs - timestamp) / 1000)) };
    }

    bucket.count += 1;
    return { allowed: true };
  };

  const middleware: RequestHandler = (request: Request, response: Response, next: NextFunction): void => {
    const verdict = evaluate(request);
    if (verdict.allowed) { next(); return; }
    response.setHeader("Retry-After", String(verdict.retryAfterSeconds));
    response.status(429).json({ error: { code: "RATE_LIMIT_EXCEEDED", message: RATE_LIMIT_MESSAGE } });
  };

  return Object.assign(middleware, { evaluate, limit, windowMs });
}

export type AiRateLimiter = ReturnType<typeof createAiRateLimiter>;