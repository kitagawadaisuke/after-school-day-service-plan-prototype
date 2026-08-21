import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createCognitoAuth } from "../server/auth/cognito.js";
import { openLoginFlow } from "../server/auth/crypto.js";
import {
  createSessionStore,
  CSRF_COOKIE_NAME,
  LOGIN_FLOW_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../server/auth/session-store.js";
import { buildApp } from "../server/app.js";
import { loadConfig } from "../server/config.js";

const IDS = Object.freeze({
  user: "018f1db5-c170-7c35-a784-3cfc6f98c201",
  tenant: "018f1db5-c170-7c35-a784-3cfc6f98c101",
  facility: "018f1db5-c170-7c35-a784-3cfc6f98c301",
  session: "018f1db5-c170-7c35-a784-3cfc6f98c401",
});

const SECRET = "test-cookie-secret-that-is-at-least-32-characters-long";
const FIXED_NOW = new Date("2026-08-14T00:00:00.000Z");

function cognitoConfig(overrides = {}) {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    appBaseUrl: "https://st.example.test",
    databaseUrl: undefined,
    databaseSsl: false,
    dbPoolMax: 2,
    authMode: "cognito",
    cookieSecret: SECRET,
    auditHashKey: "test-audit-key-not-for-production",
    cognito: {
      userPoolId: "ap-northeast-1_example",
      clientId: "example-client-id",
      clientSecret: undefined,
      domain: "https://example.auth.ap-northeast-1.amazoncognito.com",
      callbackUri: "https://st.example.test/auth/callback",
      logoutUri: "https://st.example.test/",
      sessionTtlSeconds: 12 * 60 * 60,
    },
    devActor: null,
    ...overrides,
  };
}

function deterministicRandom() {
  let byte = 1;
  return (size) => Buffer.alloc(size, byte++);
}

function identityPool(calls) {
  const client = {
    async query(sql, parameters = []) {
      calls.push({ sql, parameters });
      if (sql.includes("resolve_cognito_identity")) {
        return {
          rows: [{
            user_id: IDS.user,
            tenant_id: IDS.tenant,
            role: "facility_admin",
            display_name: "テスト職員",
            facility_ids: [IDS.facility],
          }],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  return { async connect() { return client; } };
}

test("本番のCognito設定はCookie秘密鍵と必要な接続情報を必須にする", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", AUTH_MODE: "cognito", DATABASE_URL: "postgres://db", AUDIT_HASH_KEY: "a".repeat(32) }),
    /COOKIE_SECRET.*COGNITO_USER_POOL_ID.*COGNITO_CLIENT_ID.*COGNITO_DOMAIN/,
  );
  const config = loadConfig({
    NODE_ENV: "production",
    AUTH_MODE: "cognito",
    APP_BASE_URL: "https://st.example.test",
    DATABASE_URL: "postgres://db",
    DATABASE_SSL: "require",
    DATABASE_CA_FILE: "/opt/michinote/certs/aws-rds-ap-northeast-3-bundle.pem",
    AUDIT_HASH_KEY: "a".repeat(32),
    PDF_FINALIZATION_SECRET: "p".repeat(64),
    DOCUMENT_KMS_KEY_ARN: "arn:aws:kms:ap-northeast-1:123456789012:key/test-key",
    DOCUMENT_BUCKET: "michinote-test-documents",
    COOKIE_SECRET: "b".repeat(32),
    COGNITO_USER_POOL_ID: "ap-northeast-1_example",
    COGNITO_CLIENT_ID: "client",
    COGNITO_DOMAIN: "https://example.auth.ap-northeast-1.amazoncognito.com",
    COGNITO_CALLBACK_URL: "https://st.example.test/auth/callback",
    COGNITO_LOGOUT_URL: "https://st.example.test/",
    SESSION_TTL_HOURS: "8",
  });
  assert.equal(config.cognito.sessionTtlSeconds, 8 * 60 * 60);
  assert.equal(config.cognito.callbackUri, "https://st.example.test/auth/callback");
  assert.equal(config.cognito.logoutUri, "https://st.example.test/");
  assert.throws(
    () => loadConfig({
      NODE_ENV: "test",
      AUTH_MODE: "cognito",
      APP_BASE_URL: "https://st.example.test",
      COOKIE_SECRET: "b".repeat(32),
      COGNITO_USER_POOL_ID: "ap-northeast-1_example",
      COGNITO_CLIENT_ID: "client",
      COGNITO_DOMAIN: "https://example.auth.ap-northeast-1.amazoncognito.com",
      COGNITO_LOGOUT_URL: "https://attacker.example/",
    }),
    /COGNITO_LOGOUT_URL.*exactly match/,
  );
});

test("ログイン開始はstate・nonce・S256 PKCEを使い、復帰先を同一サイト内に限定する", () => {
  const auth = createCognitoAuth({
    config: cognitoConfig(),
    pool: identityPool([]),
    randomBytesImpl: deterministicRandom(),
    now: () => FIXED_NOW,
    idTokenVerifier: { verify: async () => ({}) },
    accessTokenVerifier: { verify: async () => ({}) },
  });
  const login = auth.beginLogin("https://evil.example/steal");
  const url = new URL(login.authorizationUrl);
  assert.equal(url.pathname, "/oauth2/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), "https://st.example.test/auth/callback");
  assert.ok(url.searchParams.get("state"));
  assert.ok(url.searchParams.get("nonce"));
  assert.ok(url.searchParams.get("code_challenge"));
  const logoutUrl = new URL(auth.hostedLogoutUrl);
  assert.equal(logoutUrl.pathname, "/logout");
  assert.equal(logoutUrl.searchParams.get("client_id"), "example-client-id");
  assert.equal(logoutUrl.searchParams.get("logout_uri"), "https://st.example.test/");

  const flow = openLoginFlow(SECRET, login.flowCookie, FIXED_NOW.getTime());
  assert.equal(flow.returnTo, "/");
  assert.equal(flow.state, url.searchParams.get("state"));
  assert.equal(flow.nonce, url.searchParams.get("nonce"));
  assert.equal(login.flowCookie.includes(flow.verifier), false);

  const encodedRedirect = auth.beginLogin("/%2F%2Fevil.example/path");
  const encodedFlow = openLoginFlow(SECRET, encodedRedirect.flowCookie, FIXED_NOW.getTime());
  assert.equal(encodedFlow.returnTo, "/");
});

test("callbackはコードをPKCEで交換し両JWTとnonceを検証して、DBにはハッシュだけを保存する", async () => {
  const dbCalls = [];
  const tokenCalls = [];
  const verified = [];
  let expectedNonce;
  const auth = createCognitoAuth({
    config: cognitoConfig(),
    pool: identityPool(dbCalls),
    randomBytesImpl: deterministicRandom(),
    idFactory: () => IDS.session,
    now: () => FIXED_NOW,
    fetchImpl: async (url, options) => {
      tokenCalls.push({ url, options });
      return {
        ok: true,
        async json() {
          return { id_token: "signed-id-token", access_token: "signed-access-token" };
        },
      };
    },
    idTokenVerifier: {
      async verify(token) {
        verified.push(token);
        return { sub: "cognito-subject", nonce: expectedNonce };
      },
    },
    accessTokenVerifier: {
      async verify(token) {
        verified.push(token);
        return { sub: "cognito-subject" };
      },
    },
  });
  const login = auth.beginLogin("/children?status=active");
  const loginUrl = new URL(login.authorizationUrl);
  expectedNonce = loginUrl.searchParams.get("nonce");
  const state = loginUrl.searchParams.get("state");
  const flow = openLoginFlow(SECRET, login.flowCookie, FIXED_NOW.getTime());

  const result = await auth.completeLogin({
    code: "one-time-code",
    state,
    flowCookie: login.flowCookie,
    ip: "192.0.2.10",
    userAgent: "Mozilla/5.0 Chrome/120.0",
  });

  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].url, "https://example.auth.ap-northeast-1.amazoncognito.com/oauth2/token");
  const body = new URLSearchParams(tokenCalls[0].options.body);
  assert.equal(body.get("code"), "one-time-code");
  assert.equal(body.get("code_verifier"), flow.verifier);
  assert.deepEqual(verified, ["signed-id-token", "signed-access-token"]);
  assert.equal(result.returnTo, "/children?status=active");

  const insert = dbCalls.find((call) => call.sql.includes("insert into app_private.sessions"));
  assert.ok(insert);
  assert.ok(Buffer.isBuffer(insert.parameters[1]));
  assert.ok(Buffer.isBuffer(insert.parameters[4]));
  const persisted = JSON.stringify(dbCalls);
  for (const secretValue of [result.sessionToken, result.csrfToken, "one-time-code", "signed-id-token", "signed-access-token"]) {
    assert.equal(persisted.includes(secretValue), false);
  }
});

test("state不一致ではtoken endpointへ接続しない", async () => {
  let fetchCount = 0;
  const auth = createCognitoAuth({
    config: cognitoConfig(),
    pool: identityPool([]),
    randomBytesImpl: deterministicRandom(),
    now: () => FIXED_NOW,
    fetchImpl: async () => { fetchCount += 1; },
    idTokenVerifier: { verify: async () => ({}) },
    accessTokenVerifier: { verify: async () => ({}) },
  });
  const login = auth.beginLogin("/");
  await assert.rejects(
    () => auth.completeLogin({ code: "code", state: "wrong-state", flowCookie: login.flowCookie }),
    (error) => error.code === "INVALID_AUTH_STATE",
  );
  assert.equal(fetchCount, 0);
});

test("未ログインの更新要求はCSRFエラーではなく401を返す", async () => {
  const auth = createCognitoAuth({
    config: cognitoConfig(),
    pool: identityPool([]),
    randomBytesImpl: deterministicRandom(),
    now: () => FIXED_NOW,
    idTokenVerifier: { verify: async () => ({}) },
    accessTokenVerifier: { verify: async () => ({}) },
  });
  await assert.rejects(
    () => auth.authenticateRequest({ method: "POST", cookies: {}, headers: {} }),
    (error) => error.code === "AUTH_REQUIRED" && error.statusCode === 401,
  );
});

test("セッション照合はCSRFを検証し、無効化後は同じCookieを受理しない", async () => {
  const rows = {};
  let revoked = false;
  const client = {
    async query(sql, parameters = []) {
      if (sql.includes("insert into app_private.sessions")) {
        rows.id = parameters[0];
        rows.tokenHash = parameters[1];
        rows.userId = parameters[2];
        rows.tenantId = parameters[3];
        rows.csrfHash = parameters[4];
        return { rows: [] };
      }
      if (sql.includes("from app_private.sessions") && sql.includes("expires_at > now()")) {
        if (revoked || !rows.tokenHash?.equals(parameters[0])) return { rows: [] };
        return { rows: [{ id: rows.id, user_id: rows.userId, active_tenant_id: rows.tenantId, csrf_token_hash: rows.csrfHash }] };
      }
      if (sql.includes("from public.app_users")) {
        return { rows: [{ user_id: IDS.user, tenant_id: IDS.tenant, role: "support_staff", display_name: "職員", facility_ids: [IDS.facility] }] };
      }
      if (sql.includes("update app_private.sessions") && sql.includes("revoked_at")) {
        revoked = true;
      }
      return { rows: [] };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };
  const store = createSessionStore({
    pool,
    secret: SECRET,
    ttlSeconds: 3600,
    randomBytesImpl: deterministicRandom(),
    idFactory: () => IDS.session,
    now: () => FIXED_NOW,
  });
  const created = await store.createSession({ userId: IDS.user, tenantId: IDS.tenant });
  assert.notEqual(rows.tokenHash.toString("hex"), created.sessionToken);
  assert.notEqual(rows.csrfHash.toString("hex"), created.csrfToken);

  const actor = await store.authenticate(created.sessionToken, { method: "POST", csrfToken: created.csrfToken });
  assert.equal(actor.userId, IDS.user);
  assert.equal(actor.csrfToken, created.csrfToken);
  await assert.rejects(
    () => store.authenticate(created.sessionToken, { method: "PATCH", csrfToken: "incorrect" }),
    (error) => error.code === "CSRF_INVALID",
  );
  await store.revoke(created.sessionToken);
  await assert.rejects(
    () => store.authenticate(created.sessionToken, { method: "GET" }),
    (error) => error.code === "AUTH_REQUIRED",
  );
});

test("認証ルートはSecure Cookieを設定し、logoutでサーバー失効後に削除する", async () => {
  let logoutCalled = false;
  const fakeAuth = {
    beginLogin() {
      return { authorizationUrl: "https://login.example/authorize", flowCookie: "sealed-flow" };
    },
    async completeLogin() {
      return {
        sessionToken: "opaque-session",
        csrfToken: "csrf-value",
        expiresAt: new Date("2026-08-14T12:00:00.000Z"),
        returnTo: "/",
      };
    },
    async authenticateRequest() {
      return { userId: IDS.user, tenantId: IDS.tenant, role: "tenant_admin", facilityIds: [IDS.facility] };
    },
    async logout() {
      logoutCalled = true;
      return {
        logoutUrl: "https://login.example/logout?client_id=client&logout_uri=https%3A%2F%2Fst.example.test%2F",
      };
    },
  };
  const app = await buildApp({ config: cognitoConfig(), pool: null, cognitoAuth: fakeAuth });

  const login = await app.inject({ method: "GET", url: "/auth/login?returnTo=%2F" });
  assert.equal(login.statusCode, 302);
  assert.match(String(login.headers["set-cookie"]), new RegExp(`${LOGIN_FLOW_COOKIE_NAME}=.*HttpOnly.*Secure.*SameSite=Lax`, "i"));

  const callback = await app.inject({
    method: "GET",
    url: "/auth/callback?code=code&state=state",
    headers: { cookie: `${LOGIN_FLOW_COOKIE_NAME}=sealed-flow` },
  });
  assert.equal(callback.statusCode, 302);
  const callbackCookies = String(callback.headers["set-cookie"]);
  assert.match(callbackCookies, new RegExp(`${SESSION_COOKIE_NAME}=opaque-session.*HttpOnly.*Secure.*SameSite=Lax`, "i"));
  assert.match(callbackCookies, new RegExp(`${CSRF_COOKIE_NAME}=csrf-value.*Secure.*SameSite=Lax`, "i"));

  const logout = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=opaque-session; ${CSRF_COOKIE_NAME}=csrf-value`,
      "x-csrf-token": "csrf-value",
    },
  });
  assert.equal(logout.statusCode, 200);
  assert.equal(
    logout.json().logoutUrl,
    "https://login.example/logout?client_id=client&logout_uri=https%3A%2F%2Fst.example.test%2F",
  );
  assert.equal(logoutCalled, true);
  assert.match(String(logout.headers["set-cookie"]), new RegExp(`${SESSION_COOKIE_NAME}=;`));
  await app.close();
});

test("runtimeロールはCognito subjectから有効な所属だけを解決できる", async () => {
  const db = new PGlite();
  const migrationsUrl = new URL("../db/migrations/", import.meta.url);
  const names = (await readdir(migrationsUrl))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/i.test(name))
    .sort();
  for (const name of names) {
    await db.exec(await readFile(new URL(name, migrationsUrl), "utf8"));
  }
  await db.exec(await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8"));
  await db.query(
    "select app_private.provision_tenant($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    [
      IDS.tenant,
      "架空法人",
      IDS.user,
      "verified-cognito-subject",
      "staff@example.invalid",
      "テスト職員",
      "018f1db5-c170-7c35-a784-3cfc6f98c402",
      IDS.facility,
      "T-01",
      "架空事業所",
    ],
  );
  await db.exec("set role michinote_runtime");
  const resolved = await db.query(
    "select user_id, tenant_id, role, display_name, facility_ids from app_private.resolve_cognito_identity($1)",
    ["verified-cognito-subject"],
  );
  assert.equal(resolved.rows.length, 1);
  assert.equal(resolved.rows[0].user_id, IDS.user);
  assert.equal(resolved.rows[0].tenant_id, IDS.tenant);
  assert.deepEqual(resolved.rows[0].facility_ids, [IDS.facility]);
  const missing = await db.query(
    "select user_id from app_private.resolve_cognito_identity($1)",
    ["unknown-subject"],
  );
  assert.equal(missing.rows.length, 0);
  await db.close();
});
