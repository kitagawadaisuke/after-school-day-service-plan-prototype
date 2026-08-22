import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { buildApp } from "../server/app.js";

const IDS = {
  tenant: "018f1db5-c170-7c35-a784-3cfc6f98e101",
  user: "018f1db5-c170-7c35-a784-3cfc6f98e201",
  facility: "018f1db5-c170-7c35-a784-3cfc6f98e301",
  membership: "018f1db5-c170-7c35-a784-3cfc6f98e401",
  child: "018f1db5-c170-7c35-a784-3cfc6f98e501",
};

const migrationsDirectory = new URL("../db/migrations/", import.meta.url);
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort();
const migrationSql = (await Promise.all(
  migrationFiles.map((name) => readFile(new URL(name, migrationsDirectory), "utf8")),
)).join("\n");
const grantsSql = await readFile(new URL("../db/runtime-grants.sql", import.meta.url), "utf8");

function testConfig(role = "tenant_admin") {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    appBaseUrl: "http://127.0.0.1",
    databaseUrl: "postgresql://unused-in-pglite",
    databaseSsl: false,
    dbPoolMax: 2,
    authMode: "development",
    cookieSecret: undefined,
    auditHashKey: "schedule-api-test-audit-key",
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

async function setupDatabase() {
  const db = new PGlite();
  await db.exec(migrationSql);
  await db.exec(grantsSql);
  await db.query(
    "select app_private.provision_tenant($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    [
      IDS.tenant,
      "テスト法人",
      IDS.user,
      "cognito-schedule-test",
      "schedule-test@example.invalid",
      "テスト管理者",
      IDS.membership,
      IDS.facility,
      "F-001",
      "テスト事業所",
    ],
  );
  await db.query(
    `insert into public.children (
      id, tenant_id, facility_id, management_code, display_name, legal_name, created_by, updated_by
    ) values ($1, $2, $3, 'C-001', 'Aさん', 'テスト 利用児', $4, $4)`,
    [IDS.child, IDS.tenant, IDS.facility, IDS.user],
  );
  await db.exec("set role michinote_runtime");
  return db;
}

function pglitePool(db) {
  return {
    async connect() {
      return {
        query(sql, parameters) {
          return db.query(sql, parameters);
        },
        release() {},
      };
    },
    query(sql, parameters) {
      return db.query(sql, parameters);
    },
  };
}

function createSchedule(app, scheduleKind, items = []) {
  return app.inject({
    method: "POST",
    url: `/api/v1/children/${IDS.child}/schedules`,
    payload: {
      scheduleKind,
      validFrom: "2026-04-01",
      validTo: "2026-09-30",
      summary: scheduleKind === "current" ? "現在の生活" : "計画後の生活",
      items,
    },
  });
}

test("現在と計画後の週間予定を別系列で保存し、日跨ぎ時刻を保持できる", async () => {
  const db = await setupDatabase();
  const app = await buildApp({ config: testConfig(), pool: pglitePool(db) });
  try {
    const current = await createSchedule(app, "current", [
      {
        dayOfWeek: 1,
        startMinute: 1320,
        endMinute: 1560,
        activity: "就寝",
        location: "自宅",
      },
    ]);
    const planned = await createSchedule(app, "planned", [
      {
        dayOfWeek: 1,
        startMinute: 900,
        endMinute: 1020,
        activity: "放課後等デイサービス",
        serviceKind: "障害児通所支援",
      },
    ]);

    assert.equal(current.statusCode, 201);
    assert.equal(planned.statusCode, 201);
    assert.equal(current.json().scheduleKind, "current");
    assert.equal(planned.json().scheduleKind, "planned");
    assert.equal(current.json().versionNumber, 1);
    assert.equal(planned.json().versionNumber, 1);
    assert.equal(current.json().items[0].endMinute, 1560);
    assert.notEqual(current.json().id, planned.json().id);

    const currentList = await app.inject({
      method: "GET",
      url: `/api/v1/children/${IDS.child}/schedules?scheduleKind=current`,
    });
    assert.equal(currentList.statusCode, 200);
    assert.deepEqual(currentList.json().items.map((item) => item.id), [current.json().id]);
    assert.equal(Object.hasOwn(currentList.json().items[0], "items"), false);
  } finally {
    await app.close();
    await db.close();
  }
});

test("週間予定は楽観ロックで編集し、確定後は上書きできない", async () => {
  const db = await setupDatabase();
  const app = await buildApp({ config: testConfig(), pool: pglitePool(db) });
  try {
    const created = await createSchedule(app, "planned", [
      { dayOfWeek: 2, startMinute: 900, endMinute: 1020, activity: "支援" },
    ]);
    assert.equal(created.statusCode, 201);
    assert.equal(created.headers.etag, '"1"');

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/schedules/${created.json().id}`,
      headers: { "if-match": created.headers.etag },
      payload: {
        summary: "本人・家族と確認した計画後の週間予定",
        items: [
          { dayOfWeek: 2, startMinute: 900, endMinute: 1030, activity: "支援と振り返り" },
        ],
      },
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.headers.etag, '"2"');

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/schedules/${created.json().id}`,
      headers: { "if-match": '"1"' },
      payload: { summary: "古い画面からの更新" },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, "EDIT_CONFLICT");

    const finalized = await app.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/schedules/${created.json().id}/finalize`,
      headers: { "if-match": updated.headers.etag },
    });
    assert.equal(finalized.statusCode, 200);
    assert.equal(finalized.json().status, "finalized");
    assert.equal(finalized.headers.etag, '"3"');

    const immutable = await app.inject({
      method: "PATCH",
      url: `/api/v1/children/${IDS.child}/schedules/${created.json().id}`,
      headers: { "if-match": finalized.headers.etag },
      payload: { summary: "確定後の変更" },
    });
    assert.equal(immutable.statusCode, 409);
    assert.equal(immutable.json().error.code, "IMMUTABLE_SCHEDULE");
  } finally {
    await app.close();
    await db.close();
  }
});

test("支援員は週間予定を編集できるが確定はできず、入力不備も安全に拒否する", async () => {
  const db = await setupDatabase();
  const supportApp = await buildApp({ config: testConfig("support_staff"), pool: pglitePool(db) });
  try {
    const invalid = await createSchedule(supportApp, "current", [
      {
        dayOfWeek: 0,
        startMinute: 900,
        endMinute: 800,
        activity: "SECRET-SCHEDULE-VALUE",
      },
    ]);
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, "VALIDATION_ERROR");
    assert.equal(invalid.body.includes("SECRET-SCHEDULE-VALUE"), false);

    const created = await createSchedule(supportApp, "current", [
      { dayOfWeek: 0, startMinute: 480, endMinute: 540, activity: "起床・身支度" },
    ]);
    assert.equal(created.statusCode, 201);

    const forbidden = await supportApp.inject({
      method: "POST",
      url: `/api/v1/children/${IDS.child}/schedules/${created.json().id}/finalize`,
      headers: { "if-match": created.headers.etag },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.json().error.code, "FORBIDDEN");
  } finally {
    await supportApp.close();
    await db.close();
  }
});
