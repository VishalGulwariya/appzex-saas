import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CookieOptions, Request, Response, NextFunction } from "express";
import { env } from "../config/env.js";

export const SESSION_COOKIE = "appzex_session";
export const CSRF_COOKIE = "appzex_csrf";
const csrfMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

function cookieOptions(httpOnly: boolean, maxAge: number): CookieOptions {
  return { httpOnly, secure: env.COOKIE_SECURE, sameSite: env.COOKIE_SAME_SITE, path: "/", maxAge };
}

export function setSessionCookie(response: Response, token: string): void {
  response.cookie(SESSION_COOKIE, token, cookieOptions(true, env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000));
}
export function clearSessionCookie(response: Response): void {
  response.clearCookie(SESSION_COOKIE, cookieOptions(true, 0));
}

function signCsrfNonce(nonce: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(`csrf:${nonce}`).digest("base64url");
}
export function createCsrfToken(): string {
  const nonce = randomBytes(32).toString("base64url");
  return `${nonce}.${signCsrfNonce(nonce)}`;
}
export function setCsrfCookie(response: Response, token: string): void {
  response.cookie(CSRF_COOKIE, token, cookieOptions(false, csrfMaxAgeMs));
}
export function clearCsrfCookie(response: Response): void {
  response.clearCookie(CSRF_COOKIE, cookieOptions(false, 0));
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
function isValidCsrfToken(token: string): boolean {
  const [nonce, signature, extra] = token.split(".");
  return Boolean(nonce && signature && !extra && safeEqual(signature, signCsrfNonce(nonce)));
}
export function requireCsrf(request: Request, response: Response, next: NextFunction): void {
  const origin = request.get("origin");
  if (origin && origin !== env.WEB_ORIGIN) {
    response.status(403).json({ error: { code: "CSRF_REJECTED", message: "Request origin is not allowed" } });
    return;
  }
  const cookieToken = request.cookies?.[CSRF_COOKIE];
  const headerToken = request.get("x-csrf-token");
  if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken) || !isValidCsrfToken(headerToken)) {
    response.status(403).json({ error: { code: "CSRF_REJECTED", message: "A valid CSRF token is required" } });
    return;
  }
  next();
}
export function csrfProtection(request: Request, response: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    next();
    return;
  }
  requireCsrf(request, response, next);
}
