import { randomBytes } from "node:crypto";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { badRequest, forbidden, unauthorized } from "../errors.js";
import {
  constantTimeEqual,
  openLoginFlow,
  pkceChallenge,
  randomOpaqueToken,
  safeReturnTo,
  sealLoginFlow,
} from "./crypto.js";
import {
  createSessionStore,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "./session-store.js";

function cognitoEndpoint(domain, path) {
  const base = domain.endsWith("/") ? domain : `${domain}/`;
  return new URL(path.replace(/^\//, ""), base).toString();
}

function createDefaultVerifiers(config) {
  return {
    idTokenVerifier: CognitoJwtVerifier.create({
      userPoolId: config.cognito.userPoolId,
      tokenUse: "id",
      clientId: config.cognito.clientId,
    }),
    accessTokenVerifier: CognitoJwtVerifier.create({
      userPoolId: config.cognito.userPoolId,
      tokenUse: "access",
      clientId: config.cognito.clientId,
    }),
  };
}

async function parseTokenResponse(response) {
  if (!response?.ok) throw unauthorized("ログインを完了できませんでした。もう一度お試しください。");
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw unauthorized("ログインを完了できませんでした。もう一度お試しください。");
  }
  if (typeof payload?.id_token !== "string" || typeof payload?.access_token !== "string") {
    throw unauthorized("ログインを完了できませんでした。もう一度お試しください。");
  }
  return payload;
}

export function createCognitoAuth({
  config,
  pool,
  fetchImpl = globalThis.fetch,
  idTokenVerifier,
  accessTokenVerifier,
  now = () => new Date(),
  randomBytesImpl = randomBytes,
  idFactory,
} = {}) {
  if (!config?.cognito || config.authMode !== "cognito") {
    throw new TypeError("Cognito configuration is required");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");

  const defaults = idTokenVerifier && accessTokenVerifier ? null : createDefaultVerifiers(config);
  const verifyId = idTokenVerifier || defaults.idTokenVerifier;
  const verifyAccess = accessTokenVerifier || defaults.accessTokenVerifier;
  const redirectUri = config.cognito.callbackUri || new URL("/auth/callback", config.appBaseUrl).toString();
  const logoutUri = config.cognito.logoutUri || new URL("/", config.appBaseUrl).toString();
  const hostedLogoutUrl = new URL(cognitoEndpoint(config.cognito.domain, "/logout"));
  hostedLogoutUrl.searchParams.set("client_id", config.cognito.clientId);
  hostedLogoutUrl.searchParams.set("logout_uri", logoutUri);
  const store = createSessionStore({
    pool,
    secret: config.cookieSecret,
    ttlSeconds: config.cognito.sessionTtlSeconds,
    now,
    randomBytesImpl,
    idFactory,
  });

  function beginLogin(returnToValue) {
    const state = randomOpaqueToken(32, randomBytesImpl);
    const nonce = randomOpaqueToken(32, randomBytesImpl);
    const verifier = randomOpaqueToken(32, randomBytesImpl);
    const flow = {
      state,
      nonce,
      verifier,
      returnTo: safeReturnTo(returnToValue),
      createdAt: now().getTime(),
    };
    const authorizationUrl = new URL(cognitoEndpoint(config.cognito.domain, "/oauth2/authorize"));
    authorizationUrl.searchParams.set("client_id", config.cognito.clientId);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("scope", "openid email profile");
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("nonce", nonce);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
    return {
      authorizationUrl: authorizationUrl.toString(),
      flowCookie: sealLoginFlow(config.cookieSecret, flow, randomBytesImpl),
    };
  }

  async function exchangeCode(code, verifier) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.cognito.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    if (config.cognito.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${config.cognito.clientId}:${config.cognito.clientSecret}`, "utf8").toString("base64")}`;
    }
    let response;
    try {
      response = await fetchImpl(cognitoEndpoint(config.cognito.domain, "/oauth2/token"), {
        method: "POST",
        headers,
        body: body.toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw unauthorized("ログインを完了できませんでした。もう一度お試しください。");
    }
    return parseTokenResponse(response);
  }

  async function completeLogin({ code, state, flowCookie, ip, userAgent }) {
    if (typeof code !== "string" || code.length < 1 || typeof state !== "string" || state.length < 1) {
      throw badRequest("INVALID_AUTH_CALLBACK", "ログイン応答が不正です。最初からやり直してください。");
    }
    const flow = openLoginFlow(config.cookieSecret, flowCookie, now().getTime());
    if (!flow || !constantTimeEqual(flow.state, state)) {
      throw badRequest("INVALID_AUTH_STATE", "ログインの安全確認に失敗しました。最初からやり直してください。");
    }

    const tokens = await exchangeCode(code, flow.verifier);
    let idClaims;
    let accessClaims;
    try {
      [idClaims, accessClaims] = await Promise.all([
        verifyId.verify(tokens.id_token),
        verifyAccess.verify(tokens.access_token),
      ]);
    } catch {
      throw unauthorized("ログイン情報を検証できませんでした。最初からやり直してください。");
    }
    if (
      typeof idClaims?.sub !== "string"
      || !constantTimeEqual(idClaims.nonce, flow.nonce)
      || !constantTimeEqual(idClaims.sub, accessClaims?.sub)
    ) {
      throw unauthorized("ログイン情報を検証できませんでした。最初からやり直してください。");
    }

    const identity = await store.resolveCognitoIdentity(idClaims.sub, {
      email: typeof idClaims.email === "string" ? idClaims.email : null,
      emailVerified: idClaims.email_verified === true || idClaims.email_verified === "true",
    });
    const session = await store.createSession(identity, { ip, userAgent });
    return { ...session, returnTo: flow.returnTo };
  }

  async function authenticateRequest(request) {
    const method = String(request.method || "GET").toUpperCase();
    const sessionToken = request.cookies?.[SESSION_COOKIE_NAME];
    if (!sessionToken) throw unauthorized();
    const csrfCookie = request.cookies?.[CSRF_COOKIE_NAME];
    const csrfHeader = request.headers["x-csrf-token"];
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !constantTimeEqual(csrfCookie, csrfHeader)) {
      throw forbidden("安全確認に失敗しました。画面を再読み込みしてください。");
    }
    return store.authenticate(sessionToken, {
      method,
      csrfToken: ["GET", "HEAD", "OPTIONS"].includes(method) ? csrfCookie : csrfHeader,
    });
  }

  async function logout(request) {
    const sessionToken = request.cookies?.[SESSION_COOKIE_NAME];
    if (!sessionToken) return { logoutUrl: hostedLogoutUrl.toString() };
    const csrfCookie = request.cookies?.[CSRF_COOKIE_NAME];
    const csrfHeader = request.headers["x-csrf-token"];
    if (!constantTimeEqual(csrfCookie, csrfHeader)) {
      throw forbidden("安全確認に失敗しました。画面を再読み込みしてください。");
    }
    await store.revoke(sessionToken);
    return { logoutUrl: hostedLogoutUrl.toString() };
  }

  return Object.freeze({
    beginLogin,
    completeLogin,
    authenticateRequest,
    logout,
    redirectUri,
    hostedLogoutUrl: hostedLogoutUrl.toString(),
  });
}
