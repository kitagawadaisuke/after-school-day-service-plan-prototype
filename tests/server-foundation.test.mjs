import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../server/app.js";
import { purgeExpiredIdempotency } from "../server/db/idempotency-retention.js";
import { loadConfig } from "../server/config.js";
import { buildPgPoolOptions } from "../server/db/pool.js";
import { withTenantTransaction } from "../server/db/tenant-transaction.js";

const IDS = {
  tenant: "018f1db5-c170-7c35-a784-3cfc6f98c101",
  user: "018f1db5-c170-7c35-a784-3cfc6f98c201",
  facility: "018f1db5-c170-7c35-a784-3cfc6f98c301",
};
const TEST_RDS_CA = "-----BEGIN CERTIFICATE-----\nZmFrZS10ZXN0LWNh\n-----END CERTIFICATE-----\n";

function testConfig(overrides = {}) {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    appBaseUrl: "http://127.0.0.1",
    publicSaasUi: false,
    databaseUrl: undefined,
    databaseSsl: false,
    dbPoolMax: 2,
    authMode: "development",
    cookieSecret: undefined,
    auditHashKey: "test-audit-key-not-for-production",
    cognito: null,
    devActor: {
      userId: IDS.user,
      tenantId: IDS.tenant,
      facilityIds: [IDS.facility],
      role: "tenant_admin",
      displayName: "テスト管理者",
    },
    ...overrides,
  };
}

test("本番環境では開発認証とDB未設定を拒否する", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production", AUTH_MODE: "development" }),
    /DATABASE_URL.*AUTH_MODE.*AUDIT_HASH_KEY/,
  );
});

test("production accepts complete discrete RDS settings without creating a connection URL", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    AUTH_MODE: "cognito",
    APP_BASE_URL: "https://michinote.example.jp",
    DATABASE_HOST: "database.private.example",
    DATABASE_PORT: "5432",
    DATABASE_NAME: "michinote",
    DATABASE_USER: "michinote_runtime",
    DATABASE_PASSWORD: "a-secret-that-is-not-placed-in-a-url",
    DATABASE_SSL: "require",
    DATABASE_CA_FILE: "/opt/michinote/certs/aws-rds-ap-northeast-3-bundle.pem",
    AUDIT_HASH_KEY: "a".repeat(32),
    PDF_FINALIZATION_SECRET: "p".repeat(64),
    DOCUMENT_KMS_KEY_ARN: "arn:aws:kms:ap-northeast-3:123456789012:key/test-key",
    DOCUMENT_BUCKET: "michinote-test-documents",
    COOKIE_SECRET: "b".repeat(32),
    COGNITO_USER_POOL_ID: "ap-northeast-3_example",
    COGNITO_CLIENT_ID: "example-client",
    COGNITO_DOMAIN: "https://example.auth.ap-northeast-3.amazoncognito.com",
    COGNITO_CALLBACK_URL: "https://michinote.example.jp/auth/callback",
    COGNITO_LOGOUT_URL: "https://michinote.example.jp/",
  });

  assert.equal(config.databaseUrl, undefined);
  const poolOptions = buildPgPoolOptions(config, { readFile: () => TEST_RDS_CA });
  assert.equal(Object.hasOwn(poolOptions, "connectionString"), false);
  assert.equal(poolOptions.host, "database.private.example");
  assert.equal(poolOptions.database, "michinote");
  assert.equal(poolOptions.user, "michinote_runtime");
  assert.equal(poolOptions.password, "a-secret-that-is-not-placed-in-a-url");
  assert.deepEqual(poolOptions.ssl, { rejectUnauthorized: true, ca: TEST_RDS_CA });
});

test("production rejects DB TLS without a pinned CA bundle", () => {
  const base = {
    NODE_ENV: "production",
    AUTH_MODE: "cognito",
    APP_BASE_URL: "https://michinote.example.jp",
    DATABASE_URL: "postgresql://database.private.example/michinote",
    AUDIT_HASH_KEY: "a".repeat(32),
    PDF_FINALIZATION_SECRET: "p".repeat(64),
    DOCUMENT_KMS_KEY_ARN: "arn:aws:kms:ap-northeast-3:123456789012:key/test-key",
    DOCUMENT_BUCKET: "michinote-test-documents",
    COOKIE_SECRET: "b".repeat(32),
    COGNITO_USER_POOL_ID: "ap-northeast-3_example",
    COGNITO_CLIENT_ID: "example-client",
    COGNITO_DOMAIN: "https://example.auth.ap-northeast-3.amazoncognito.com",
  };
  assert.throws(() => loadConfig(base), /DATABASE_SSL.*DATABASE_CA_FILE/);
  assert.throws(
    () => loadConfig({ ...base, DATABASE_SSL: "require" }),
    /DATABASE_CA_FILE/,
  );
});

test("TLS pool refuses unreadable or malformed CA files", () => {
  const config = testConfig({
    databaseUrl: "postgresql://database.private.example/michinote",
    databaseSsl: true,
    databaseCaFile: "/private/rds-ca.pem",
  });
  assert.throws(
    () => buildPgPoolOptions(config, { readFile() { throw new Error("path detail"); } }),
    /CA bundle could not be read/,
  );
  assert.throws(
    () => buildPgPoolOptions(config, { readFile: () => "not-a-certificate" }),
    /not a PEM certificate bundle/,
  );
});

test("TLS pool rejects connection-string options that could override pinned CA verification", () => {
  for (const option of [
    "sslmode=disable",
    "ssl=0",
    "sslrootcert=%2Ftmp%2Funtrusted.pem",
    "%73slmode=require",
    "uselibpqcompat=true&sslmode=require",
  ]) {
    const config = testConfig({
      databaseUrl: `postgresql://database.private.example/michinote?${option}`,
      databaseSsl: true,
      databaseCaFile: "/private/rds-ca.pem",
    });
    assert.throws(
      () => buildPgPoolOptions(config, { readFile: () => TEST_RDS_CA }),
      /must not contain TLS options/,
    );
  }
});

test("legacy DATABASE_URL remains supported", () => {
  const config = loadConfig({ DATABASE_URL: "postgresql://legacy.example/michinote" });
  const poolOptions = buildPgPoolOptions(config);
  assert.equal(poolOptions.connectionString, "postgresql://legacy.example/michinote");
  assert.equal(Object.hasOwn(poolOptions, "password"), false);
});

test("partial or ambiguous database settings are rejected before startup", () => {
  assert.throws(
    () => loadConfig({ DATABASE_HOST: "db.example", DATABASE_USER: "runtime" }),
    /DATABASE_NAME.*DATABASE_PASSWORD/,
  );
  assert.throws(
    () => loadConfig({
      DATABASE_URL: "postgresql://legacy.example/michinote",
      DATABASE_HOST: "db.example",
      DATABASE_NAME: "michinote",
      DATABASE_USER: "runtime",
      DATABASE_PASSWORD: "secret",
    }),
    /DATABASE_URL/,
  );
});

test("ヘルスチェックとセキュリティヘッダーを返す", async () => {
  const app = await buildApp({ config: testConfig(), pool: null });
  const response = await app.inject({ method: "GET", url: "/health/live" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, "ok");
  assert.match(response.headers["content-security-policy"], /default-src 'self'/);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  const notReady = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(notReady.statusCode, 503);
  assert.equal(notReady.json().reason, "database_not_configured");
  await app.close();
});

test("認証済みセッションは法人・施設・役割を返す", async () => {
  const app = await buildApp({ config: testConfig(), pool: null });
  const response = await app.inject({ method: "GET", url: "/api/v1/session" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.expires, "0");
  assert.equal(response.json().tenant.id, IDS.tenant);
  assert.equal(response.json().user.role, "tenant_admin");
  assert.deepEqual(response.json().facilityIds, [IDS.facility]);
  await app.close();
});

test("閲覧者による利用児登録はDBへ到達する前に403となる", async () => {
  const config = testConfig({ devActor: { ...testConfig().devActor, role: "viewer" } });
  const app = await buildApp({ config, pool: null });
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/children",
    payload: {
      facilityId: IDS.facility,
      managementCode: "C-001",
      displayName: "Aさん",
      legalName: "架空 利用児",
    },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "FORBIDDEN");
  await app.close();
});

test("不正な利用児IDは個人情報を含まない400を返す", async () => {
  const app = await buildApp({ config: testConfig(), pool: null });
  const response = await app.inject({ method: "GET", url: "/api/v1/children/not-a-uuid" });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "VALIDATION_ERROR");
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.body.includes("legalName"), false);
  await app.close();
});

test("all API responses prevent shared-device caching", async () => {
  const app = await buildApp({ config: testConfig(), pool: null });
  const response = await app.inject({ method: "GET", url: "/api/v1/not-found" });
  assert.equal(response.statusCode, 404);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.headers.pragma, "no-cache");
  assert.equal(response.headers.expires, "0");
  await app.close();
});

test("idempotency retention purges bounded batches until the expired queue is drained", async () => {
  const counts = [250, 250, 12];
  const calls = [];
  const pool = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows: [{ deleted: counts.shift() }] };
    },
  };
  const deleted = await purgeExpiredIdempotency(pool, { batchSize: 250, maxBatches: 10 });
  assert.equal(deleted, 512);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.parameters), [[250], [250], [250]]);
});

test("連絡帳は家庭または事業所の本文を必須にする", async () => {
  const app = await buildApp({ config: testConfig(), pool: null });
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/children/${IDS.user}/contact-book`,
    payload: { entryDate: "2026-08-14" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "VALIDATION_ERROR");
  await app.close();
});

test("閲覧者は連絡帳を登録できない", async () => {
  const config = testConfig({ devActor: { ...testConfig().devActor, role: "viewer" } });
  const app = await buildApp({ config, pool: null });
  const response = await app.inject({
    method: "POST",
    url: `/api/v1/children/${IDS.user}/contact-book`,
    payload: { entryDate: "2026-08-14", familyMessage: "テスト連絡" },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "FORBIDDEN");
  await app.close();
});

test("テナントDB処理はSET LOCAL相当の設定とcommitを同一接続で行う", async () => {
  const calls = [];
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows: [{ ok: true }] };
    },
    release() {
      calls.push({ sql: "release" });
    },
  };
  const pool = { async connect() { return client; } };
  const actor = testConfig().devActor;
  const value = await withTenantTransaction(pool, actor, async (connection) => {
    assert.equal(connection, client);
    return "done";
  });
  assert.equal(value, "done");
  assert.deepEqual(calls.map((call) => call.sql), [
    "begin",
    "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
    "commit",
    "release",
  ]);
  assert.deepEqual(calls[1].parameters, [IDS.tenant, IDS.user]);
});

test("DB処理失敗時はrollbackして接続を返却する", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      return { rows: [] };
    },
    release() {
      calls.push("release");
    },
  };
  const pool = { async connect() { return client; } };
  await assert.rejects(
    () => withTenantTransaction(pool, testConfig().devActor, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.deepEqual(calls, [
    "begin",
    "select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)",
    "rollback",
    "release",
  ]);
});
