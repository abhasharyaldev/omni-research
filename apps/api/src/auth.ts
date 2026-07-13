import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { loginSchema, newId, registerSchema } from "@omni/shared";
import { getPrisma } from "@omni/database";
import { ApiHttpError, audit } from "./util.js";

export const SESSION_COOKIE = "omni_session";
const SESSION_TTL_MS = 14 * 86_400_000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type AuthedUser = { id: string; email: string; displayName: string; role: string; defaultProvider: string };

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthedUser;
  }
}

export async function loadUser(request: FastifyRequest): Promise<AuthedUser | undefined> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return undefined;
  const prisma = getPrisma();
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt < new Date()) return undefined;
  return {
    id: session.user.id,
    email: session.user.email,
    displayName: session.user.displayName,
    role: session.user.role,
    defaultProvider: session.user.defaultProvider,
  };
}

export function requireUser(request: FastifyRequest): AuthedUser {
  if (!request.user) throw new ApiHttpError(401, "unauthenticated", "Sign in to continue");
  return request.user;
}

/**
 * CSRF guard for mutating requests: the SPA always sends `x-omni-csrf: 1`.
 * Cross-site HTML forms cannot set custom headers, and the session cookie is
 * SameSite=Lax, so this double layer blocks CSRF.
 */
export function requireCsrfHeader(request: FastifyRequest): void {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  if (request.headers["x-omni-csrf"] !== "1") {
    throw new ApiHttpError(403, "csrf", "Missing CSRF header");
  }
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.post("/api/auth/register", { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } }, async (request, reply) => {
    const input = registerSchema.parse(request.body);
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw new ApiHttpError(409, "email-taken", "An account with this email already exists");
    const user = await prisma.user.create({
      data: {
        id: newId("usr"),
        email: input.email,
        passwordHash: await bcrypt.hash(input.password, 11),
        displayName: input.displayName,
      },
    });
    const token = randomBytes(32).toString("base64url");
    await prisma.session.create({
      data: {
        id: newId("ses"),
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        userAgent: request.headers["user-agent"]?.slice(0, 300),
        ip: request.ip,
      },
    });
    setSessionCookie(reply, token);
    await audit(user.id, "auth.register", "user", user.id, request);
    return { user: { id: user.id, email: user.email, displayName: user.displayName } };
  });

  app.post("/api/auth/login", { config: { rateLimit: { max: 15, timeWindow: "10 minutes" } } }, async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const user = await prisma.user.findUnique({ where: { email: input.email } });
    // Constant-shape comparison to avoid user-enumeration timing differences.
    const hash = user?.passwordHash ?? "$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
    const ok = await bcrypt.compare(input.password, hash);
    if (!user || !ok) throw new ApiHttpError(401, "invalid-credentials", "Email or password is incorrect");
    const token = randomBytes(32).toString("base64url");
    await prisma.session.create({
      data: {
        id: newId("ses"),
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        userAgent: request.headers["user-agent"]?.slice(0, 300),
        ip: request.ip,
      },
    });
    setSessionCookie(reply, token);
    await audit(user.id, "auth.login", "user", user.id, request);
    return { user: { id: user.id, email: user.email, displayName: user.displayName } };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) {
      await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => {
    return { user: request.user ?? null };
  });

  app.delete("/api/auth/account", async (request, reply) => {
    const user = requireUser(request);
    await audit(user.id, "auth.delete-account", "user", user.id, request);
    await prisma.user.delete({ where: { id: user.id } });
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
}

/** Constant-time string comparison helper (exported for tests). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
