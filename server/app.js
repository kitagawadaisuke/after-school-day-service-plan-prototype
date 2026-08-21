import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { LogController } from "fastify";
import { createCognitoAdmin } from "./aws/cognito-admin.js";
import { createKmsFieldEncryption } from "./aws/field-encryption.js";
import { createCognitoAuth } from "./auth/cognito.js";
import { createLocalAuth } from "./auth/local.js";
import { createCognitoAuthenticator, createDevelopmentAuthenticator } from "./auth/request-auth.js";
import { loadConfig } from "./config.js";
import { createPgPool } from "./db/pool.js";
import { startIdempotencyRetentionWorker } from "./db/idempotency-retention.js";
import { startSecurityRetentionWorker } from "./db/security-retention.js";
import { AppError } from "./errors.js";
import { createBoundedPdfRenderer, createPlaywrightPdfRenderer } from "./pdf/renderer.js";
import { createDatabaseDocumentStorage, createS3DocumentStorage, createUnavailableDocumentStorage } from "./pdf/storage.js";
import { createSecurityAuthAudit } from "./security-auth-audit.js";
import { createWritingAssistant } from "./services/writing-assist.js";
import { createMailService } from "./services/mail.js";
import { apiRoutes } from "./routes/api.js";
import { authRoutes } from "./routes/auth.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SHARED_STATIC_FILES = Object.freeze({
  "/saas.html": ["saas.html", "text/html; charset=utf-8"],
  "/styles/saas.css": ["styles/saas.css", "text/css; charset=utf-8"],
  "/src/saas-app.js": ["src/saas-app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/src/app.js": ["src/app.js", "text/javascript; charset=utf-8"],
  "/src/demo-data.js": ["src/demo-data.js", "text/javascript; charset=utf-8"],
  "/src/plan-engine.js": ["src/plan-engine.js", "text/javascript; charset=utf-8"],
  "/login.html": ["login.html", "text/html; charset=utf-8"],
  "/src/local-login.js": ["src/local-login.js", "text/javascript; charset=utf-8"],
  "/signup.html": ["signup.html", "text/html; charset=utf-8"],
  "/src/local-signup.js": ["src/local-signup.js", "text/javascript; charset=utf-8"],
  "/reset-password.html": ["reset-password.html", "text/html; charset=utf-8"],
  "/src/password-setup.js": ["src/password-setup.js", "text/javascript; charset=utf-8"],
  "/src/utils.js": ["src/utils.js", "text/javascript; charset=utf-8"],
});

function defaultLogger(config) {
  if (config.nodeEnv === "test") return false;
  return {
    level: config.nodeEnv === "production" ? "info" : "warn",
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.query.code",
        "req.query.state",
        "res.headers.set-cookie",
        "password",
        "token",
        "body",
      ],
      censor: "[REDACTED]",
    },
  };
}

function publicDatabaseError(error) {
  if (error?.code === "23505") return new AppError(409, "DUPLICATE", "同じ識別情報のデータがすでに登録されています。");
  if (["23503", "23514", "22P02", "22023"].includes(error?.code)) {
    return new AppError(400, "INVALID_RELATION", "関連する入力内容を確認してください。");
  }
  if (error?.code === "42501") return new AppError(403, "FORBIDDEN", "この操作を行う権限がありません。");
  if (error?.code === "55000") return new AppError(409, "IMMUTABLE_DOCUMENT", "確定済みの内容は変更できません。新版を作成してください。");
  return null;
}

function registerStaticRoutes(app, projectRoot, config) {
  // Keep the local prototype available during development while making the
  // authenticated SaaS shell the only root document in Cognito/production.
  // PUBLIC_SAAS_UI is intentionally opt-in for the shared development demo.
  const useSaasShell =
    config.nodeEnv === "production" ||
    config.authMode === "cognito" ||
    config.authMode === "local" ||
    config.publicSaasUi === true;
  const entryFile = useSaasShell ? "saas.html" : "index.html";
  const staticFiles = {
    "/": [entryFile, "text/html; charset=utf-8"],
    ...SHARED_STATIC_FILES,
    ...(useSaasShell ? {} : {
      "/index.html": ["index.html", "text/html; charset=utf-8"],
      "/demo": ["index.html", "text/html; charset=utf-8"],
    }),
  };
  for (const [route, [relativePath, contentType]] of Object.entries(staticFiles)) {
    app.get(route, async (_request, reply) => {
      const path = join(projectRoot, relativePath);
      await access(path);
      reply.type(contentType).header("Cache-Control", "no-store");
      return reply.send(createReadStream(path));
    });
  }
}

export async function buildApp(options = {}) {
  const config = options.config || loadConfig();
  const app = Fastify({
    logger: options.logger ?? defaultLogger(config),
    // 参考資料はPDF/Office文書を15MBまで受け付ける。Base64 JSONで送る
    // ため、転送時の余白を含めて22MBに制限する。
    bodyLimit: 22 * 1024 * 1024,
    trustProxy: config.nodeEnv === "production" ? 1 : false,
    requestIdHeader: false,
    // OAuth callbacks carry one-time codes in the URL. Manual structured logs
    // below deliberately omit URLs, request bodies, cookies and tokens.
    logController: new LogController({ disableRequestLogging: true }),
  });

  const ownsPool = !options.pool;
  const pool = options.pool || createPgPool(config);
  const cognitoAuth = config.authMode === "cognito"
    ? (options.cognitoAuth || createCognitoAuth({ config, pool, ...(options.cognitoDependencies || {}) }))
    : null;
  const localAuth = config.authMode === "local"
    ? (options.localAuth || createLocalAuth({ config, pool }))
    : null;
  const cognitoAdmin = options.cognitoAdmin
    || (config.cognito?.userPoolId
      ? createCognitoAdmin({ config, ...(options.cognitoAdminDependencies || {}) })
      : null);
  const fieldEncryption = options.fieldEncryption
    || createKmsFieldEncryption({ config, ...(options.kmsDependencies || {}) });
  const ownsPdfRenderer = !options.pdfRenderer;
  const rawPdfRenderer = options.pdfRenderer || createPlaywrightPdfRenderer({
    executablePath: config.playwrightChromiumExecutablePath,
  });
  const pdfRenderer = createBoundedPdfRenderer(rawPdfRenderer, {
    maxConcurrent: config.pdfRenderConcurrency ?? 1,
    maxQueue: config.pdfRenderQueueLimit ?? 1,
    retryAfterSeconds: config.pdfRenderRetryAfterSeconds ?? 5,
  });
  const documentStorage = options.documentStorage
    || (config.documentBucket && config.documentKmsKeyArn
      ? createS3DocumentStorage({
          bucket: config.documentBucket,
          kmsKeyArn: config.documentKmsKeyArn,
          region: config.awsRegion,
          ...(options.s3Dependencies || {}),
        })
      : pool ? createDatabaseDocumentStorage({ pool }) : createUnavailableDocumentStorage());
  const authenticateRequest = options.authenticateRequest
    || (config.authMode === "development"
      ? createDevelopmentAuthenticator(config)
      : config.authMode === "local"
        ? localAuth.authenticateRequest
        : createCognitoAuthenticator(cognitoAuth));
  const recordSecurityAuthFailure = options.recordSecurityAuthFailure
    || createSecurityAuthAudit({ pool, config });
  const writingAssistant = options.writingAssistant
    || createWritingAssistant({ apiKey: config.openAiApiKey, model: config.openAiModel });
  const mailService = options.mailService || createMailService(config, options.mailDependencies);
  const idempotencyRetentionWorker = config.nodeEnv === "production" && pool
    ? startIdempotencyRetentionWorker({ pool, logger: app.log })
    : null;
  const securityRetentionWorker = config.nodeEnv === "production" && pool
    ? startSecurityRetentionWorker({ pool, logger: app.log })
    : null;

  app.decorate("config", config);
  app.decorate("db", pool);
  app.decorate("authenticateRequest", authenticateRequest);
  app.decorate("cognitoAdmin", cognitoAdmin);
  app.decorate("fieldEncryption", fieldEncryption);
  app.decorate("pdfRenderer", pdfRenderer);
  app.decorate("documentStorage", documentStorage);
  app.decorate("recordSecurityAuthFailure", recordSecurityAuthFailure);
  app.decorate("writingAssistant", writingAssistant);
  app.decorate("mailService", mailService);
  if (cognitoAuth) app.decorate("cognitoAuth", cognitoAuth);
  if (localAuth) app.decorate("localAuth", localAuth);

  // Authenticated API payloads include sensitive care and family data. Apply
  // this at the root scope so successful, error and not-found responses all
  // receive the same shared-device cache protection.
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/")) {
      reply
        .header("Cache-Control", "private, no-store")
        .header("Pragma", "no-cache")
        .header("Expires", "0");
    }
    return payload;
  });

  await app.register(cookie, { secret: config.cookieSecret || "development-cookie-secret-change-me" });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // Image resizing for an explicitly selected profile photo uses a short-lived blob URL.
        imgSrc: ["'self'", "data:", "blob:"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    referrerPolicy: { policy: "no-referrer" },
  });
  await app.register(rateLimit, {
    global: true,
    max: config.nodeEnv === "test" ? 10_000 : 300,
    timeWindow: "1 minute",
    errorResponseBuilder: (_request, context) => ({
      error: {
        code: "RATE_LIMITED",
        message: "操作が集中しています。少し待ってから再度お試しください。",
        retryAfter: context.after,
      },
    }),
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = error instanceof AppError || error?.statusCode === 403 ? error : publicDatabaseError(error);
    const statusCode = mapped?.statusCode || 500;
    const code = mapped?.code || "INTERNAL_ERROR";
    const message = mapped?.message || "処理を完了できませんでした。時間をおいて再度お試しください。";

    if (statusCode >= 500) {
      request.log.error({
        event: "request_failed",
        requestId: request.id,
        errorName: error?.name,
        errorCode: error?.code,
      });
    } else if (statusCode === 403) {
      // In development the logger is configured at warn level. Keep enough
      // route context to diagnose a denied operation without logging IDs,
      // cookies, request bodies or care-record content.
      request.log.warn({
        event: "request_forbidden",
        requestId: request.id,
        code,
        errorName: error?.name,
        errorCode: error?.code,
        method: request.method,
        route: request.routeOptions?.url || null,
        actorRole: request.actor?.role || null,
      });
    } else {
      request.log.info({ event: "request_rejected", requestId: request.id, code, statusCode });
    }

    if (statusCode === 503 && mapped?.details?.retryAfterSeconds) {
      reply.header("Retry-After", String(mapped.details.retryAfterSeconds));
    }
    reply.code(statusCode).send({
      error: {
        code,
        message,
        ...(mapped?.details ? { details: mapped.details } : {}),
        requestId: request.id,
      },
    });
  });

  const liveHandler = async () => ({ status: "ok" });
  const readyHandler = async (_request, reply) => {
    if (!pool) return reply.code(503).send({ status: "not_ready", reason: "database_not_configured" });
    try {
      await pool.query("select 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready", reason: "database_unavailable" });
    }
  };
  // Stable production endpoints used by ECS and the ALB. Keep the original
  // aliases so local tooling and older operational checks remain compatible.
  app.get("/health/live", liveHandler);
  app.get("/health/ready", readyHandler);
  app.get("/healthz", liveHandler);
  app.get("/readyz", readyHandler);

  if (cognitoAuth || localAuth) await app.register(authRoutes, { prefix: "/auth" });
  await app.register(apiRoutes, { prefix: "/api/v1" });
  registerStaticRoutes(app, options.projectRoot || PROJECT_ROOT, config);

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith("/api/");
    reply.code(404).send(isApi
      ? { error: { code: "NOT_FOUND", message: "APIが見つかりません。", requestId: request.id } }
      : "Not found");
  });

  app.addHook("onClose", async () => {
    idempotencyRetentionWorker?.stop();
    securityRetentionWorker?.stop();
    if (ownsPdfRenderer) await pdfRenderer.close();
    if (ownsPool && pool) await pool.end();
  });

  return app;
}
