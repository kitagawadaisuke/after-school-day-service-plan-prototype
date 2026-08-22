import { badRequest } from "../errors.js";
import { z } from "zod";
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

function setLocalSessionCookies(reply, result) {
  reply.setCookie(SESSION_COOKIE_NAME, result.sessionToken, {
    ...SECURE_COOKIE,
    maxAge: 12 * 60 * 60,
    expires: result.expiresAt,
  });
  reply.setCookie(CSRF_COOKIE_NAME, result.csrfToken, {
    ...CSRF_COOKIE,
    maxAge: 12 * 60 * 60,
    expires: result.expiresAt,
  });
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
  if (app.localAuth) {
    app.get("/login", async (_request, reply) => {
      noStore(reply);
      return reply.redirect("/login.html");
    });

    app.post("/local/login", async (request, reply) => {
      noStore(reply);
      let result;
      try {
        result = await app.localAuth.login({
          email: request.body?.email,
          password: request.body?.password,
          requestContext: { ip: request.ip, userAgent: request.headers["user-agent"] },
        });
      } catch (error) {
        await recordAuthenticationFailure(app, request, error);
        throw error;
      }
      setLocalSessionCookies(reply, result);
      return reply.code(200).send({ redirectTo: "/" });
    });

    app.post("/local/signup", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (request, reply) => {
      noStore(reply);
      const parsed = z.object({
        displayName: z.string().trim().min(1).max(100),
        email: z.string().trim().email().max(320),
      }).safeParse(request.body);
      if (!parsed.success) throw badRequest("INVALID_SIGNUP", "氏名とメールアドレスを確認してください。");
      if (!app.mailService) throw badRequest("MAIL_NOT_CONFIGURED", "メール送信の設定が完了していません。管理者へお問い合わせください。");
      const requested = await app.localAuth.requestSignup(parsed.data);
      if (requested) {
        const setupUrl = new URL("/reset-password.html", app.config.appBaseUrl);
        setupUrl.searchParams.set("token", requested.token);
        try {
          await app.mailService.sendSignupPasswordSetup({ to: requested.email, displayName: requested.display_name, setupUrl: setupUrl.toString() });
        } catch (error) {
          request.log.error({ event: "local_signup_delivery_failed", requestId: request.id, errorName: error?.name });
        }
      }
      return reply.code(202).send({ message: "登録用メールを送信しました。メール内のリンクからパスワードを設定してください。" });
    });

    app.post("/local/password-setup-requests", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (request, reply) => {
      noStore(reply);
      const parsed = z.object({ email: z.string().trim().email().max(320) }).safeParse(request.body);
      if (!parsed.success) throw badRequest("INVALID_EMAIL", "メールアドレスを確認してください。");
      if (!app.mailService) throw badRequest("MAIL_NOT_CONFIGURED", "メール送信の設定が完了していません。管理者へお問い合わせください。");
      const requested = await app.localAuth.requestPasswordSetup(parsed.data.email);
      if (requested) {
        const setupUrl = new URL("/reset-password.html", app.config.appBaseUrl);
        setupUrl.searchParams.set("token", requested.token);
        try {
          await app.mailService.sendPasswordSetup({ to: requested.email, displayName: requested.display_name, setupUrl: setupUrl.toString() });
        } catch (error) {
          request.log.error({ event: "local_password_setup_delivery_failed", requestId: request.id, errorName: error?.name });
        }
      }
      return reply.code(202).send({ message: "該当するアカウントがある場合は、設定用メールを送信しました。" });
    });

    app.post("/local/password-setups", { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } }, async (request, reply) => {
      noStore(reply);
      const parsed = z.object({ token: z.string().min(40).max(100), password: z.string().min(8).max(256) }).safeParse(request.body);
      if (!parsed.success) throw badRequest("INVALID_PASSWORD_SETUP", "リンクまたはパスワードを確認してください。");
      const completed = await app.localAuth.resetPassword(parsed.data.token, parsed.data.password);
      if (!completed) throw badRequest("PASSWORD_SETUP_EXPIRED", "このリンクは無効または期限切れです。もう一度メールを送信してください。");
      if (app.mailService) {
        try {
          await app.mailService.sendPasswordSetupCompleted({
            to: completed.email,
            displayName: completed.display_name,
            purpose: completed.purpose,
          });
        } catch (error) {
          request.log.error({ event: "local_password_setup_completed_delivery_failed", requestId: request.id, errorName: error?.name });
        }
      }
      return reply.code(200).send({ redirectTo: "/login.html", message: completed.purpose === "signup" ? "登録が完了しました。ログインしてください。" : "パスワードを設定しました。ログインしてください。" });
    });

    app.post("/logout", async (request, reply) => {
      noStore(reply);
      await app.localAuth.logout(request);
      reply.clearCookie(SESSION_COOKIE_NAME, SECURE_COOKIE);
      reply.clearCookie(CSRF_COOKIE_NAME, CSRF_COOKIE);
      return reply.code(200).send({ logoutUrl: new URL("/login.html", app.config.appBaseUrl).toString() });
    });
    return;
  }

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
