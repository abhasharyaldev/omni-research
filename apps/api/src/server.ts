import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { newId } from "@omni/shared";
import { redactSecrets } from "@omni/security";
import { loadUser, registerAuthRoutes, requireCsrfHeader } from "./auth.js";
import { deploymentMode, getLocalUser } from "./local-identity.js";
import { ApiHttpError } from "./util.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerSourceRoutes } from "./routes/sources.js";
import { registerReportRoutes } from "./routes/reports.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerLearningRoutes } from "./routes/learning.js";
import { registerMiscRoutes } from "./routes/misc.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerStoryRoutes } from "./routes/stories.js";
import { registerAnalystRoutes } from "./routes/analyst.js";
import { registerWorkspaceRoutes } from "./routes/workspace.js";
import { registerVideoRoutes } from "./routes/video.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "development" ? "info" : "warn",
      redact: {
        paths: ["req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']"],
        censor: "[REDACTED]",
      },
    },
    genReqId: () => newId("req"),
    trustProxy: false,
    bodyLimit: 2_000_000,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);
  await app.register(cors, {
    origin: [process.env.APP_URL ?? "http://localhost:3000"],
    credentials: true,
    allowedHeaders: ["content-type", "x-omni-csrf"],
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
  });

  app.addHook("preHandler", async (request) => {
    request.user = await loadUser(request);
    // Account-free local mode: resolve the singleton local identity
    // server-side. CSRF/origin checks still apply; hosted mode never
    // inherits this fallback.
    if (!request.user && deploymentMode() === "local") {
      request.user = await getLocalUser();
    }
    if (request.url.startsWith("/api/")) requireCsrfHeader(request);
  });

  app.setErrorHandler((error: any, request, reply) => {
    const requestId = request.id as string;
    if (error instanceof ApiHttpError) {
      return reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
        details: error.details,
        requestId,
      });
    }
    if (error instanceof ZodError) {
      return reply.status(400).send({
        code: "validation-error",
        message: "Request validation failed",
        details: error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
        requestId,
      });
    }
    if ((error as any).statusCode === 429) {
      return reply.status(429).send({
        code: "rate-limited",
        message: "Too many requests; slow down and retry shortly",
        requestId,
      });
    }
    request.log.error({ err: error }, "unhandled error");
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : redactSecrets(error.message ?? "Internal server error");
    return reply.status(500).send({ code: "internal-error", message, requestId });
  });

  await registerAuthRoutes(app);
  await registerProjectRoutes(app);
  await registerRunRoutes(app);
  await registerSourceRoutes(app);
  await registerReportRoutes(app);
  await registerProviderRoutes(app);
  await registerLearningRoutes(app);
  await registerMiscRoutes(app);
  await registerSearchRoutes(app);
  await registerStoryRoutes(app);
  await registerAnalystRoutes(app);
  await registerWorkspaceRoutes(app);
  await registerVideoRoutes(app);

  return app;
}
