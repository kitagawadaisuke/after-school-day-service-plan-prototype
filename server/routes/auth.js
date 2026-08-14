import { badRequest } from "../errors.js";
import {
  LOGIN_FLOW_MAX_AGE_SECONDS,
} from "../auth/crypto.js";
import {
  CSRF_COOKIE_NAME,
  LOGIN_FLOW_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../auth/session-store.js";

const SECURE_COOKIE = Object.freeze({
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "lax",
});

const CSRF_COOKIE = Object.freeze({
  path: "/",
  httpOnly: false,
  secure: true,
  sameSite: "lax",
});

function noStore(reply) {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
}

async function recordAuthenticationFailure(app, request, error) {
  try {
    await app.recordSecurityAuthFailure(request, error);
  } catch (auditError) {
    request.log.error({
      event: "security_auth_audit_failed",
      requestId: request.id,
      errorCode: auditError?.code,
    });
  }
}

export async function authRoutes(app) {
  app.get("/login", async (request, reply) => {
    noStore(reply);
    const returnTo = typeof request.query?.returnTo === "string" ? request.query.returnTo : "/";
    const login = app.cognitoAuth.beginLogin(returnTo);
    reply.setCookie(LOGIN_FLOW_COOKIE_NAME, login.flowCookie, {
      ...SECURE_COOKIE,
      maxAge: LOGIN_FLOW_MAX_AGE_SECONDS,
    });
    return reply.redirect(login.authorizationUrl);
  });

  app.get("/callback", async (request, reply) => {
    noStore(reply);
    reply.clearCookie(LOGIN_FLOW_COOKIE_NAME, SECURE_COOKIE);
    if (request.query?.error) {
      const error = badRequest("COGNITO_AUTH_FAILED", "ログインが中断されました。最初からやり直してください。");
      await recordAuthenticationFailure(app, request, error);
      throw error;
    }
    let result;
    try {
      result = await app.cognitoAuth.completeLogin({
        code: request.query?.code,
        state: request.query?.state,
        flowCookie: request.cookies?.[LOGIN_FLOW_COOKIE_NAME],
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      });
    } catch (error) {
      await recordAuthenticationFailure(app, request, error);
      throw error;
    }
    reply.setCookie(SESSION_COOKIE_NAME, result.sessionToken, {
      ...SECURE_COOKIE,
      maxAge: app.config.cognito.sessionTtlSeconds,
      expires: result.expiresAt,
    });
    reply.setCookie(CSRF_COOKIE_NAME, result.csrfToken, {
      ...CSRF_COOKIE,
      maxAge: app.config.cognito.sessionTtlSeconds,
      expires: result.expiresAt,
    });
    return reply.redirect(result.returnTo);
  });

  app.post("/logout", async (request, reply) => {
    noStore(reply);
    const result = await app.cognitoAuth.logout(request);
    reply.clearCookie(SESSION_COOKIE_NAME, SECURE_COOKIE);
    reply.clearCookie(CSRF_COOKIE_NAME, CSRF_COOKIE);
    reply.clearCookie(LOGIN_FLOW_COOKIE_NAME, SECURE_COOKIE);
    return reply.code(200).send({ logoutUrl: result.logoutUrl });
  });
}

export const AUTH_COOKIE_OPTIONS = SECURE_COOKIE;
