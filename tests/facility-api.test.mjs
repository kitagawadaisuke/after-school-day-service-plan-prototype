import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { buildApp } from "../server/app.js";

const IDS = {
  tenant: "018f1db5-c170-7c35-a784-3cfc6f991101",
  user: "018f1db5-c170-7c35-a784-3cfc6f991201",
  facility: "018f1db5-c170-7c35-a784-3cfc6f991301",
  membership: "018f1db5-c170-7c35-a784-3cfc6f991401",
};
const migrationsDirectory = new URL("../db/migrations/", import.meta.url);
const migrationFiles = (await readdir(migrationsDirectory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
const migrationSql = (await Promise.all(
  migrationFiles.map((name) => readFile(new URL(name, migrationsDirectory), "utf8")),
)).join("\n");
const grantsSql = await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8");

function config(role = "tenant_admin") {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    appBaseUrl: "http://127.0.0.1",
    databaseUrl: "postgresql://unused-in-pglite",
    databaseSsl: false,
    dbPoolMax: 2,
    authMode: "development",
    auditHashKey: "facility-api-test-audit-key",
    cognito: null,
    devActor: {
      userId: IDS.user,
      tenantId: IDS.tenant,
      facilityIds: [IDS.facility],
      role,
      displayName: "テスト管理者",
    },
  };
}

function pool(db) {
  return {
    async connect() {
      return { query: (sql, parameters) => db.query(sql, parameters), release() {} };
    },
    query: (sql, parameters) => db.query(sql, parameters),
  };
}

async function setup() {
  const db = new PGlite();
  await db.exec(migrationSql);
  await db.exec(grantsSql);
  await db.query(
    "select app_private.provision_tenant($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    [
      IDS.tenant,
      "テスト法人",
      IDS.user,
      "cognito-facility-test",
      "facility-test@example.invalid",
      "テスト管理者",
      IDS.membership,
      IDS.facility,
      "F-001",
      "中央事業所",
    ],
  );
  await db.exec("set role michinote_runtime");
  return db;
}

test("法人管理者は事業所を重複なく登録し、ETagで更新できる", async () => {
  const db = await setup();
  const app = await buildApp({ config: config(), pool: pool(db) });
  try {
    const createRequest = {
      method: "POST",
      url: "/api/v1/facilities",
      headers: { "idempotency-key": "facility-create-0001" },
      payload: { code: "F-002", name: "東事業所", serviceType: "放課後等デイサービス" },
    };
    const created = await app.inject(createRequest);
    const replayed = await app.inject(createRequest);
    assert.equal(created.statusCode, 201);
    assert.equal(replayed.statusCode, 201);
    assert.equal(replayed.headers["idempotency-replayed"], "true");
    assert.equal(replayed.json().id, created.json().id);

    const changed = await app.inject({
      method: "PATCH",
      url: `/api/v1/facilities/${created.json().id}`,
      headers: { "if-match": created.headers.etag },
      payload: { name: "東事業所（新名称）" },
    });
    assert.equal(changed.statusCode, 200);
    assert.equal(changed.headers.etag, '"2"');

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/facilities/${created.json().id}`,
      headers: { "if-match": created.headers.etag },
      payload: { name: "古い画面の名称" },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "EDIT_CONFLICT");

    const list = await app.inject({ method: "GET", url: "/api/v1/facilities" });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().items.length, 2);

    const audit = await app.inject({
      method: "GET",
      url: "/api/v1/audit-events?action=facility.created",
    });
    assert.equal(audit.statusCode, 200);
    assert.equal(audit.json().items.length, 1);
    assert.equal(audit.json().items[0].resourceId, created.json().id);
    assert.equal(JSON.stringify(audit.json()).includes("東事業所"), false);
  } finally {
    await app.close();
    await db.close();
  }
});

test("施設管理者は法人の事業所を追加できない", async () => {
  const app = await buildApp({ config: config("facility_admin"), pool: null });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/facilities",
      payload: { code: "F-999", name: "権限外事業所" },
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});
